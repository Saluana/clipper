# ASR Service Design

artifact_id: 54f4f6f4-5f8d-4d4e-9a63-d6a99f0c6a0c

## Overview

The ASR subsystem provides transcription services using Groq Whisper ("whisper-large-v3-turbo") for media processed by the clip worker and (future) standalone ASR jobs. It abstracts provider interaction, manages job lifecycle, produces standardized artifacts (SRT, plain text, optional JSON segment metadata), and integrates with existing storage, DB, queue, logging, metrics, and cleanup processes.

Key goals: reliability (retries + idempotency), observability (metrics + events), extensibility (provider interface), and reuse (content hash caching).

## Architecture

### High-level flow (internal worker integration)

```mermaid
flowchart TD
  W[Clip Worker] -->|Needs subtitles| A[ASR Module]
  A -->|Check cache (mediaHash,model)| C[(Postgres: asr_jobs, asr_artifacts)]
  A -->|Hit & valid| R[Return artifact refs]
  A -->|Miss| Q[Queue (pg-boss asr queue)]
  AQ[ASR Worker] -->|claim job| Q
  AQ -->|fetch media (scratch path)| FS[(Scratch FS)]
  AQ -->|Groq Whisper API| G[Groq]
  G -->|segments text| AQ
  AQ -->|Build artifacts SRT/Text/JSON| S[Formatter]
  AQ -->|Store artifacts| S3[(Results Bucket)]
  AQ -->|Update status/events| C
  Client -->|GET /v1/asr/jobs/:id| API
  Client -->|GET /v1/asr/jobs/:id/results| API
```

### Components

-   ASRFacade: high-level entry for worker to request transcripts; handles cache, enqueue, and reuse.
-   ASRQueueAdapter: dedicated queue topic (e.g., `asr`) using existing pg-boss instance.
-   ASRWorker: processes queued ASR jobs with concurrency ASR_CONCURRENCY.
-   GroqWhisperProvider: concrete implementation calling Groq speech-to-text endpoint.
-   TranscriptFormatter: converts provider segments to SRT, text, JSON; merges short gaps.
-   StorageRepo (existing): stores transcript artifacts under results/<clipJobId|asrJobId>/transcript/\*.
-   DB Repos: AsrJobsRepository, AsrArtifactsRepository (or augment existing schema).
-   MetricsEmitter: records counters/histograms.
-   Cleanup: extended logic for transcript artifacts.

## Data Model

Proposed tables (Drizzle conceptual):

```ts
// enums
export type AsrJobStatus = 'queued' | 'processing' | 'done' | 'failed';

// asr_jobs
// Purpose: track each transcription request (internal or external)
// Indexes: (media_hash, model_version) unique partial where status='done'

/* drizzle pseudo */
const asrJobs = pgTable('asr_jobs', {
    id: uuid('id').primaryKey().defaultRandom(),
    clipJobId: uuid('clip_job_id')
        .references(() => jobs.id)
        .nullable(), // optional link to clip job
    sourceType: text('source_type').notNull(), // upload|youtube|internal
    sourceKey: text('source_key'),
    mediaHash: text('media_hash').notNull(), // sha256 of raw audio bytes
    modelVersion: text('model_version').notNull(),
    languageHint: text('language_hint'),
    detectedLanguage: text('detected_language'),
    durationSec: integer('duration_sec'),
    status: text('status').$type<AsrJobStatus>().notNull().default('queued'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true })
        .defaultNow()
        .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
        .defaultNow()
        .notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
});

const asrArtifacts = pgTable('asr_artifacts', {
    asrJobId: uuid('asr_job_id')
        .references(() => asrJobs.id)
        .notNull(),
    kind: text('kind').notNull(), // 'srt' | 'text' | 'json'
    storageKey: text('storage_key').notNull(),
    sizeBytes: integer('size_bytes'),
    createdAt: timestamp('created_at', { withTimezone: true })
        .defaultNow()
        .notNull(),
    primaryKey: primaryKey({ columns: ['asr_job_id', 'kind'] }),
});

// Unique reuse index
// unique(media_hash, model_version) where status='done'
```

TypeScript interfaces:

```ts
export interface AsrJobRecord {
    id: string;
    clipJobId?: string;
    sourceType: 'upload' | 'youtube' | 'internal';
    sourceKey?: string;
    mediaHash: string;
    modelVersion: string;
    languageHint?: string;
    detectedLanguage?: string;
    durationSec?: number;
    status: AsrJobStatus;
    errorCode?: string;
    errorMessage?: string;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    expiresAt?: string;
}

export interface AsrArtifactRecord {
    asrJobId: string;
    kind: 'srt' | 'text' | 'json';
    storageKey: string;
    sizeBytes?: number;
    createdAt: string;
}
```

## Interfaces

```ts
export interface AsrProviderSegment {
    startSec: number;
    endSec: number;
    text: string;
    words?: Array<{ startSec: number; endSec: number; text: string }>;
}

export interface AsrProviderResult {
    segments: AsrProviderSegment[];
    detectedLanguage?: string;
    modelVersion: string;
    durationSec: number;
}

export interface AsrProvider {
    transcribe(opts: {
        filePath: string; // local path to media (audio or video)
        languageHint?: string; // 'auto' or code
        timeoutMs: number;
        signal?: AbortSignal;
    }): Promise<AsrProviderResult>;
}

export interface AsrJobsRepository {
    create(
        row: Omit<AsrJobRecord, 'createdAt' | 'updatedAt' | 'status'> &
            Partial<Pick<AsrJobRecord, 'status'>>
    ): Promise<AsrJobRecord>;
    get(id: string): Promise<AsrJobRecord | null>;
    getReusable(
        mediaHash: string,
        modelVersion: string
    ): Promise<(AsrJobRecord & { artifacts: AsrArtifactRecord[] }) | null>;
    patch(id: string, patch: Partial<AsrJobRecord>): Promise<AsrJobRecord>;
}

export interface AsrArtifactsRepository {
    put(artifact: AsrArtifactRecord): Promise<void>;
    list(asrJobId: string): Promise<AsrArtifactRecord[]>;
}

export interface AsrFacade {
    request(opts: {
        clipJobId?: string;
        filePath: string;
        sourceType: 'upload' | 'youtube' | 'internal';
        languageHint?: string;
    }): Promise<{ asrJobId: string; status: AsrJobStatus }>;
    awaitResult(
        asrJobId: string
    ): Promise<{ job: AsrJobRecord; artifacts?: AsrArtifactRecord[] }>;
}
```

## Provider Implementation (Groq Whisper)

HTTP per docs (pseudo):

-   Endpoint: POST https://api.groq.com/openai/v1/audio/transcriptions
-   Headers: Authorization: Bearer <GROQ_API_KEY>; Content-Type: multipart/form-data
-   Fields: model (GROQ_MODEL), file (binary), response_format=json (for segments), temperature? (optional)

Pseudo-code:

```ts
async function transcribe({
    filePath,
    languageHint,
    timeoutMs,
}: Args): Promise<AsrProviderResult> {
    const form = new FormData();
    form.set('model', process.env.GROQ_MODEL || 'whisper-large-v3-turbo');
    if (languageHint && languageHint !== 'auto')
        form.set('language', languageHint);
    form.set('response_format', 'verbose_json');
    form.set(
        'file',
        new File(
            [await Bun.file(filePath).arrayBuffer()],
            path.basename(filePath)
        )
    );

    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
            body: form,
            signal: controller.signal,
        }
    );
    clearTimeout(to);

    if (!res.ok)
        throw new ProviderHttpError(res.status, await safeRedactedBody(res));
    const json = await res.json();
    // Map Groq Whisper verbose_json -> segments
    const segments: AsrProviderSegment[] = json.segments.map((s: any) => ({
        startSec: s.start,
        endSec: s.end,
        text: s.text.trim(),
        words: s.words?.map((w: any) => ({
            startSec: w.start,
            endSec: w.end,
            text: w.word,
        })),
    }));
    return {
        segments,
        detectedLanguage: json.language,
        modelVersion: json.model || form.get('model')?.toString() || 'unknown',
        durationSec: segments.length ? segments[segments.length - 1].endSec : 0,
    };
}
```

Retry logic wraps `transcribe` with exponential backoff on network/5xx/429.

## Transcript Formatting

Algorithm:

1. Normalize segments: trim text, collapse repeated whitespace.
2. Merge adjacent segments if gap < MERGE_GAP_MS (150) and combined length < MAX_LINE_CHARS (~120).
3. For each merged segment create SRT cue with sequential index starting at 1.
4. Timestamp formatting: HH:MM:SS,mmm using floor for start, ceil for end.
5. Plain text: join segment.text with single space; enforce normalization (NFKC).
6. JSON output: array of { start, end, text } (and maybe words if available) when ASR_JSON_SEGMENTS=true.

Utility function signature:

```ts
export function buildArtifacts(
    segments: AsrProviderSegment[],
    opts: { includeJson: boolean }
): { srt: string; text: string; json?: any };
```

## Caching / Reuse

-   Compute mediaHash = SHA256(streamed audio). If a completed asr_job exists with same (mediaHash, modelVersion) and artifacts, reuse by attaching artifact references.
-   Otherwise create new job row.
-   Ensure uniqueness constraint for done jobs to avoid duplicates (upsert logic).

## Queue Processing

Queue message payload example:

```json
{ "asrJobId": "uuid", "filePath": "/tmp/ytc/clip-123/audio.m4a" }
```

Worker steps:

1. Load job; verify status queued.
2. Mark processing; event.
3. Call provider with timeout + retries.
4. Format artifacts.
5. Upload artifacts via StorageRepo (keys: results/<clipJobId|asrJobId>/transcript/{index}.srt, transcript.txt, segments.json).
6. Insert artifact rows; patch job (status=done, detectedLanguage, durationSec, completedAt).
7. Events for each state; metrics.
8. On error: patch status=failed, store errorCode/message, event, metrics.

## Error Handling

Use existing ServiceError pattern; map provider HTTP status codes:

-   400/422 -> VALIDATION_FAILED (if provider indicates input issue)
-   401/403 -> UPSTREAM_FAILURE (auth)
-   404 -> UPSTREAM_FAILURE
-   408/timeout -> TIMEOUT
-   429 -> UPSTREAM_FAILURE (with retry attempts first)
-   5xx -> UPSTREAM_FAILURE

Redact any occurrence of GROQ_API_KEY in messages.

## Metrics

Counters:

-   asr_jobs_total{status}
-   asr_provider_calls_total{outcome="success|error|retry"}

Histogram:

-   asr_latency_ms (end-to-end job duration)
-   asr_call_latency_ms (provider call duration)

Gauges:

-   asr_inflight_jobs

## Testing Strategy

Unit tests:

-   TranscriptFormatter merging logic (gaps, char limit)
-   Timestamp formatting accuracy and rounding
-   Provider response mapping (sample verbose_json -> segments)
-   Cache reuse path (existing job)

Integration tests:

-   End-to-end ASR job with a small synthetic audio file (mock provider)
-   Retry path simulation (mock 500 then 200)

E2E (with network, optional):

-   Real call behind flag RUN_ASR_E2E=true (skipped in CI by default)

Performance tests:

-   Measure formatting overhead for 1000 segments.

## Deployment & Env

New env vars (documented, .env example placeholder without real secret values):

-   GROQ_API_KEY (existing)
-   GROQ_MODEL=whisper-large-v3-turbo (default)
-   ASR_REQUEST_TIMEOUT_MS=60000
-   ASR_MAX_DURATION_SEC=7200 (cap)
-   ASR_JSON_SEGMENTS=false
-   ASR_CONCURRENCY=2
-   MERGE_GAP_MS=150

## Security Considerations

-   All outbound requests use HTTPS.
-   Abort on timeout to free resources.
-   Sanitize transcript text (remove NULLs, control chars except \n). Potential PII not filtered (future enhancement).
-   Avoid writing provider raw JSON if it contains any tokens (unlikely) – store sanitized subset.

## Migration Plan

1. Add tables asr_jobs, asr_artifacts + migrations.
2. Implement provider + formatter + repos behind feature flag ENABLE_ASR (implied by presence of GROQ_API_KEY?).
3. Integrate into clip worker pipeline (conditional subtitleLang=auto path).
4. Add optional external API endpoints (flag ENABLE_ASR_API).
5. Add cleanup support (extend existing sweeper to include transcript prefixes and asr_jobs expiration).
6. Add metrics registration.

## Open Questions / Future Work

-   Speaker diarization support (provider dependent) – placeholder fields excluded for now.
-   Multi-language detection vs forced language – rely on provider auto for MVP.
-   Partial streaming for long files – future optimization.
-   Rate limit handling analytics (capture Retry-After header value in metrics label?).
