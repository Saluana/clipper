This file is a merged representation of a subset of the codebase, containing files not matching ignore patterns, combined into a single document by Repomix.

# File Summary

## Purpose
This file contains a packed representation of the entire repository's contents.
It is designed to be easily consumable by AI systems for analysis, code review,
or other automated processes.

## File Format
The content is organized as follows:
1. This summary section
2. Repository information
3. Directory structure
4. Repository files (if enabled)
5. Multiple file entries, each consisting of:
  a. A header with the file path (## File: path/to/file)
  b. The full contents of the file in a code block

## Usage Guidelines
- This file should be treated as read-only. Any changes should be made to the
  original repository files, not this packed version.
- When processing this file, use the file path to distinguish
  between different files in the repository.
- Be aware that this file may contain sensitive information. Handle it with
  the same level of security as you would the original repository.

## Notes
- Some files may have been excluded based on .gitignore rules and Repomix's configuration
- Binary files are not included in this packed representation. Please refer to the Repository Structure section for a complete list of file paths, including binary files
- Files matching these patterns are excluded: **.test.ts
- Files matching patterns in .gitignore are excluded
- Files matching default ignore patterns are excluded
- Files are sorted by Git change count (files with more changes are at the bottom)

# Directory Structure
```
docs/
  ffmpeg.md
planning/
  asr/
    design.md
    requirements.md
    tasks.md
  ffmpeg/
    design.md
    requirements.md
    tasks.md
  design.md
  layers.md
  requirements.md
  tasks.md
src/
  api/
    index.ts
  asr/
    facade.ts
    formatter.ts
    index.ts
    provider.ts
  common/
    tests/
      common.test.js
    config.ts
    env.ts
    errors.ts
    index.ts
    logger.ts
    metrics.ts
    redact.ts
    state.ts
    time.ts
  contracts/
    index.ts
    openapi.ts
    schemas.ts
    types.ts
  data/
    db/
      connection.ts
      repos.ts
      schema.ts
    drizzle/
      meta/
        _journal.json
        0000_snapshot.json
      0000_tense_yellow_claw.sql
      0001_asr_jobs.sql
    scripts/
      admin-jobs.ts
      bootstrap-storage.ts
      cleanup.ts
      seed.ts
    api-keys.ts
    cleanup.ts
    index.ts
    media-io-upload.ts
    media-io-youtube.ts
    media-io.ts
    repo.ts
    storage.ts
  ffmpeg/
    clipper.ts
    index.ts
    progress.ts
    types.ts
  queue/
    asr.ts
    dlq-consumer.ts
    index.ts
    pgboss.ts
    publish.ts
    types.ts
  worker/
    asr.ts
    index.ts
.env.example
.gitignore
bunfig.toml
CLAUDE.md
drizzle.config.ts
index.ts
package.json
README.md
tsconfig.json
vitest.config.ts
```

# Files

## File: docs/ffmpeg.md
````markdown
# FFmpeg Clipper Deep Dive

## Goals

Fast, reliable sub-clipping of source media while:

-   Minimizing transcode time (attempt stream copy)
-   Guaranteeing playable output (fallback re-encode)
-   Streaming progress for real-time UX
-   Avoiding unbounded disk growth / memory overhead

## Design Summary

1. Validate input (start < end, duration > 0, within configured max, size guardrails)
2. Resolve local source path (already normalized by Media IO layer)
3. Attempt Copy Mode:
   ffmpeg -hide_banner -nostdin -ss <start> -to <end> -i <in> -c copy -movflags +faststart <out>
4. If non‑zero exit → Attempt Re-encode Mode:
   ffmpeg -hide_banner -nostdin -ss <start> -to <end> -i <in> -c:v libx264 -preset veryfast -profile:v main -level 4.1 -c:a aac -movflags +faststart -pix_fmt yuv420p <out>
5. Parse progress from `-progress pipe:1` stream (key=value pairs, `out_time_ms=`) → percent (0..99). Upon process exit (code 0) emit 100.
6. Debounce persistence (>=1% change OR 500ms elapsed OR final 100%).
7. Upload artifact.
8. Emit final job completion (future: attach performance metrics, source metadata, waveform, subtitles).

## Progress Parsing

FFmpeg with `-progress pipe:1 -nostats` yields lines like:

```
frame=23
out_time_ms=1234567
speed=1.5x
progress=continue
```

We track only `out_time_ms` relative to target clip duration. A cap of 99% prevents premature 100% before process exit. On exit with code 0 we emit a final 100% event.

Edge cases handled:

-   Zero or near-zero target duration (emit 100 immediately)
-   Non-monotonic or duplicated `out_time_ms` (ignored if lower than previous)
-   Duration overrun (clamped to 99)

## Error Strategy

Copy attempt failure automatically triggers fallback. Re-encode failure surfaces a structured ServiceError (consider specialized code FFMPEG_FAILED). Stderr is truncated (first N lines) to avoid bloating logs.

## Concurrency & Temp Files

Each job gets an isolated scratch subdirectory: `${SCRATCH_DIR}/jobs/<jobId>/`. Temp output uses `<jobId>-work.mp4` then final artifact key is `results/{jobId}/clip.mp4` in storage. Cleanup step removes scratch dir post-success (or leaves for inspection on failure, configurable in future via KEEP_FAILED=1).

## Potential Improvements

-   Smart keyframe alignment: probe first keyframe after start to decide copy viability before running attempt
-   Waveform generation (`-filter_complex astats|showwavespic`) for preview thumbnails
-   Thumbnail sprite extraction
-   Subtitle burn-in option (if SRT present)
-   Multi-resolution output set (1080p, 720p) -> HLS packaging
-   GPU accelerated fallback (VAAPI / NVENC) when available

## Testing Strategy

-   Integration test ensures a small sample clip completes with 100%
-   Fallback test forces copy failure by mocking spawn exit code
-   Validation tests exercise boundary errors
-   Progress unit tests feed synthetic progress stream

## Observability TODOs

-   Emit timing metrics: copy_attempt_ms, transcode_attempt_ms
-   Record whether fallback was required (boolean) for optimization insights
-   Count errors by failure phase (copy vs reencode)

## Security Considerations

-   No untrusted arguments are interpolated unsafely; times are numeric validated
-   Future: sandbox environment / seccomp profile when executing ffmpeg for defense in depth

---

Last updated: (add date when editing)
````

## File: planning/asr/design.md
````markdown
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
````

## File: planning/asr/requirements.md
````markdown
# ASR Service Requirements

artifact_id: 8e5c1c3d-5b5b-4f2e-9e2b-d9e9d6c0d5e4

## Introduction

This document defines requirements for a dedicated ASR (Automatic Speech Recognition) subsystem that integrates Groq Whisper ("whisper-large-v3-turbo") for transcribing audio extracted from media assets (video or audio files) within the clipping platform. It refines and extends the existing subtitles (ASR) requirement to enable: standalone transcription jobs, richer transcript artifacts (SRT + optional JSON segments), configurable diarization placeholder, retry & robustness policies, cost/latency observability, and future multi‑provider abstraction.

Scope (MVP for this service slice):

-   Input: local scratch media file (mp4, mp3, wav, m4a) or in-storage object referenced by key.
-   Output: persisted transcript artifacts (SRT, plain text, optional word/segment timing JSON) stored in results bucket under a predictable prefix.
-   Triggered by: (a) clip worker pipeline when subtitleLang=auto, (b) future standalone /v1/asr/jobs endpoint.
-   Provider: Groq Whisper only (extensible interface). Model name via GROQ_MODEL env.
-   Constraints: streaming not required for MVP; batch single-file transcription up to configured max duration.

Out of scope (future): speaker diarization, custom vocabulary, language detection fallback, partial real-time streaming, segmentation editing UI.

## Roles

-   API Client (integration developer) – requests ASR for an existing source.
-   Worker (clip pipeline) – invokes ASR internally to produce subtitles.
-   Operator/Admin – monitors ASR performance, errors, costs, usage.

## Functional Requirements

1. Create ASR job (internal trigger)

-   User Story: As a worker, I want to request a transcript for a prepared audio/video file so I can attach subtitles to a clip.
-   Acceptance Criteria:
    -   WHEN the worker has a media file on scratch AND invokes ASR module with {jobId, mediaPath, languageHint?} THEN the module SHALL enqueue or execute a transcription task and return a handle {asrJobId, status=pending|processing}.
    -   IF media duration > MAX_CLIP_INPUT_DURATION_SEC or > ASR_MAX_DURATION_SEC (new param) THEN module SHALL return error VALIDATION_FAILED.
    -   IF file format unsupported THEN module SHALL return error UNSUPPORTED_MEDIA.
    -   Language hint MAY be 'auto' or ISO 639-1 code; for MVP pass-through to provider.

2. Create ASR job (external API) (future flag)

-   User Story: As an API client, I want to submit an audio/video object for transcription without clipping so I can get transcripts directly.
-   Acceptance Criteria:
    -   WHEN POST /v1/asr/jobs is called with {sourceType, sourceKey|sourceUrl, language?} THEN API SHALL validate, persist asr_jobs row, and enqueue.
    -   IF feature flag ENABLE_ASR_API=false THEN API SHALL return 403 FORBIDDEN.
    -   Auth via API key as existing scheme.

3. Get ASR job status

-   User Story: As a client or worker, I want to check transcription progress so I can poll until done.
-   Acceptance Criteria:
    -   WHEN GET /v1/asr/jobs/:id THEN API SHALL return {id,status,language,startedAt,completedAt,error?,artifacts?}.
    -   IF job not found THEN 404 NOT_FOUND.
    -   Status set includes: queued, processing, done, failed.

4. Retrieve transcript artifacts

-   User Story: As a client, I want signed URLs for transcript outputs so I can download them.
-   Acceptance Criteria:
    -   WHEN GET /v1/asr/jobs/:id/results AND status=done THEN API SHALL return signed URLs for existing artifacts (at least srtUrl; optionally textUrl, jsonUrl if produced).
    -   IF not done THEN 409 CONFLICT.
    -   IF expired/cleaned THEN 410 GONE.

5. Transcript artifact generation

-   User Story: As a worker, I want standard formatted outputs.
-   Acceptance Criteria:
    -   Module SHALL always generate: SRT file with numbered cues, start/end timestamps, text lines.
    -   Module SHALL optionally generate: Plain text (concatenated segments) and JSON segments array when ASR_JSON_SEGMENTS=true.
    -   SRT timestamps SHALL be normalized HH:MM:SS,mmm; segments merged if inter-gap < 150ms to reduce fragmentation.
    -   Module SHALL ensure UTF-8 normalization and strip control characters.

6. Provider integration (Groq Whisper)

-   User Story: As a system, I want to call Groq Whisper reliably.
-   Acceptance Criteria:
    -   Module SHALL call Groq speech-to-text endpoint according to docs with model=GROQ_MODEL and audio stream or file upload.
    -   IF network/5xx error THEN module SHALL retry with exponential backoff (max 3 attempts) unless error is 4xx.
    -   IF rate limited (429) THEN module SHALL apply retry after header or capped backoff.
    -   IF unrecoverable provider error THEN job SHALL fail with UPSTREAM_FAILURE and preserve provider error code (sanitized).

7. Performance & timeouts

-   User Story: As an operator, I want bounded latency.
-   Acceptance Criteria:
    -   Module SHALL enforce per-request timeout ASR_REQUEST_TIMEOUT_MS.
    -   IF timeout occurs THEN job SHALL mark failed with TIMEOUT and metric increment.
    -   P95 transcription latency for 60s audio SHALL be ≤ 15s (observed metric, non-failing requirement).

8. Cost & usage metrics

-   User Story: As an operator, I want visibility into ASR usage.
-   Acceptance Criteria:
    -   Metrics SHALL include: asr_jobs_total{status}, asr_duration_seconds_sum, asr_provider_calls_total{outcome}, asr_latency_ms histogram.
    -   Each job record SHALL store detected language (if provided by provider) and duration.

9. Error handling & audit trail

-   User Story: As an operator, I want clear diagnostics.
-   Acceptance Criteria:
    -   Job events SHALL capture transitions and provider attempt logs (truncated/redacted tokens).
    -   Errors SHALL exclude raw API keys; messages redacted via existing redact utilities.

10. Integration with clip jobs

-   User Story: As a clip job worker, I want to reuse ASR results when reprocessing.
-   Acceptance Criteria:
    -   IF an ASR artifact set already exists for (jobId, mediaHash, modelVersion) THEN module SHALL skip recomputation and reuse artifacts.
    -   Media hash: SHA256 over audio stream extracted pre-transcription.

11. Cleanup

-   User Story: As an operator, I want transcript artifacts cleaned per retention.
-   Acceptance Criteria:
    -   Existing cleanup SHALL also delete transcript objects (prefix transcripts/ or results/<jobId>/transcript/).
    -   ASR job rows SHALL be expired same as clip jobs (RETENTION_HOURS) and marked.

## Non-Functional Requirements

-   Reliability: retries for transient provider errors; idempotent artifact generation; reuse via content hash.
-   Performance: Streaming upload chunk size tuned (≥256KB) if needed; local temp file usage minimized.
-   Scalability: Stateless service components; horizontal workers process ASR concurrently; concurrency cap ASR_CONCURRENCY.
-   Security: GROQ_API_KEY never logged; transcripts sanitized for control chars; size checks on input file.
-   Maintainability: Provider abstraction (interface) for future multi-provider; cohesive module boundaries; tests for format conversions.
-   Observability: Structured logs with correlationId; metrics enumerated above; event log for job timeline.

## Error Codes (subset)

-   VALIDATION_FAILED, UNSUPPORTED_MEDIA, UPSTREAM_FAILURE, TIMEOUT, INTERNAL, NOT_FOUND, CONFLICT, GONE.

## Constraints

-   Max input duration: min(MAX_CLIP_INPUT_DURATION_SEC, ASR_MAX_DURATION_SEC).
-   Supported formats: mp4, m4a, mp3, wav (PCM/AAC). Others fail fast.
-   Model: GROQ_MODEL env (default whisper-large-v3-turbo).
-   Timeout: ASR_REQUEST_TIMEOUT_MS (default 60000).
-   Retention: aligns with RETENTION_HOURS.
````

## File: planning/ffmpeg/design.md
````markdown
artifact_id: 6a31b93c-48f2-445d-813a-11811111818d
content_type: text/markdown
title: design.md

# FFmpeg Service (Clipper) Technical Design

## 1. Overview

The FFmpeg Service, also known as the "Clipper," is a core component responsible for executing video clipping operations. It is designed for efficiency and resilience, prioritizing a high-speed stream-copy approach while providing a reliable re-encoding fallback. The service is a self-contained module that will be consumed by the Worker Runtime.

## 2. Architecture

The service will be encapsulated within the `src/ffmpeg` directory. It exposes a single `Clipper` interface, which the worker will use.

### System Flow

```mermaid
graph TD
    A[Worker Runtime] -- clip(args) --> B{Clipper Service};
    B -- 1. Attempt Stream Copy --> C[FFmpeg Process (copy)];
    C -- stderr --> D[Progress Parser];
    D -- progress % --> A;
    C -- exit code --> B;
    B -- Success --> E[Return Clip Path];
    B -- Failure --> F{2. Attempt Re-encode};
    F -- ffmpeg spawn --> G[FFmpeg Process (re-encode)];
    G -- stderr --> D;
    G -- exit code --> F;
    F -- Success --> E;
    F -- Failure --> H[Throw ServiceError];
    E --> A;
    H --> A;
```

### Core Components

-   **`BunClipper`**: The primary implementation of the `Clipper` interface. It orchestrates the FFmpeg process execution, including the fallback logic.
-   **`ProgressParser`**: A utility that consumes the `stderr` stream from an FFmpeg process and yields standardized progress percentages.

## 3. Components and Interfaces

### TypeScript Interfaces

These interfaces define the contract for the service and its data structures.

```typescript
// src/ffmpeg/types.ts

/** Result from a successful clip operation. */
export interface ClipResult {
    /** The local filesystem path to the generated clip. */
    localPath: string;
    /** An async iterable that yields progress from 0 to 100. */
    progress$: AsyncIterable<number>;
}

/** Arguments for the clip method. */
export interface ClipArgs {
    /** The local filesystem path to the source video. */
    input: string;
    /** The start time of the clip in seconds. */
    startSec: number;
    /** The end time of the clip in seconds. */
    endSec: number;
    /** The unique ID of the job for logging and temp file naming. */
    jobId: string;
}

/** The main interface for the FFmpeg clipping service. */
export interface Clipper {
    clip(args: ClipArgs): Promise<ClipResult>;
}
```

## 4. FFmpeg Execution Strategy

The service will use `Bun.spawn` for non-blocking execution of FFmpeg.

### Primary Strategy: Stream Copy

This is the fastest method as it avoids re-encoding video and audio streams.

-   **Command**: `ffmpeg -y -hide_banner -progress pipe:1 -ss <start> -i <input> -to <end> -c copy -movflags +faststart <output.mp4>`
-   **`-progress pipe:1`**: Sends machine-readable progress to `stdout` (or another file descriptor), which is easier to parse than the human-readable `stderr` logs.
-   **`-movflags +faststart`**: Crucial for web playback, moving the moov atom to the beginning of the file.

### Fallback Strategy: Re-encode

This is used if the stream copy fails. It is more CPU-intensive but far more reliable.

-   **Command**: `ffmpeg -y -hide_banner -progress pipe:1 -ss <start> -i <input> -to <end> -c:v libx264 -preset veryfast -c:a aac -movflags +faststart <output.mp4>`
-   **`-c:v libx264 -preset veryfast`**: A good balance of speed and quality for the video codec.
-   **`-c:a aac`**: A widely compatible audio codec.

## 5. Progress Parsing

The `ProgressParser` will be an `AsyncGenerator` that takes a `ReadableStream` and the total clip duration.

```typescript
// src/ffmpeg/progress.ts

export async function* parseFfmpegProgress(
    stream: ReadableStream<Uint8Array>,
    totalDurationSec: number
): AsyncIterable<number> {
    const reader = stream.getReader();
    const textDecoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += textDecoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // Keep the last partial line

        for (const line of lines) {
            if (line.startsWith('out_time_ms=')) {
                const ms = parseInt(line.split('=')[1]);
                const percent = Math.round(
                    (ms / 1_000_000 / totalDurationSec) * 100
                );
                yield Math.min(percent, 99); // Cap at 99 until process exits
            }
        }
    }
    yield 100; // Signal completion
}
```

## 6. Error Handling

-   **FFmpeg Process Errors**: If `Bun.spawn` returns a non-zero exit code, the service will throw a `ServiceError` with `code: 'FFMPEG_FAILED'`. The error message will include the exit code and any captured `stderr` output for diagnostics.
-   **File System Errors**: Errors creating directories or writing files will be caught and re-thrown as `ServiceError` with `code: 'FILESYSTEM_ERROR'`.
-   The worker is responsible for catching these errors and marking the job as `failed`.

## 7. Testing Strategy

-   **Unit Tests**:
    -   Test the `ProgressParser` with mock `ReadableStream` data containing sample FFmpeg progress output.
-   **Integration Tests (`ffmpeg.integration.test.ts`)**:
    -   Create a test that requires `ffmpeg` to be installed in the environment.
    -   Use a small, known video file (e.g., `test-assets/sample.mp4`).
    -   **Test Case 1**: Verify a successful stream-copy clip. Check the output file's existence and approximate duration.
    -   **Test Case 2**: (Optional) Craft a scenario that forces a re-encode and verify its success.
    -   **Test Case 3**: Verify that progress updates are emitted correctly during a clip operation.
````

## File: planning/ffmpeg/requirements.md
````markdown
artifact_id: 24281813-d129-47b1-818d-351818641733
content_type: text/markdown
title: requirements.md

# FFmpeg Service Requirements

## Introduction

This document outlines the functional and non-functional requirements for the FFmpeg Service (Clipper). This service is responsible for creating video clips from a larger source video file based on specified start and end times. It must be fast, reliable, and provide feedback on its progress.

## 1. Core Clipping Functionality

### User Story

As a user of the platform, I want to request a video clip from a source file by providing start and end timecodes, so that I can get a smaller video containing only the segment I'm interested in.

### Acceptance Criteria

-   **WHEN** a clipping job is initiated with a valid source file, start time, and end time,
    **THEN** the service **SHALL** attempt to create the clip using a fast stream-copy method (`-c copy`).
-   **IF** the stream-copy method succeeds,
    **THEN** the output **SHALL** be a valid MP4 file containing the exact requested segment.
-   **IF** the stream-copy method fails for any reason (e.g., codec incompatibility, keyframe issues),
    **THEN** the service **SHALL** automatically attempt to create the clip by re-encoding it with a reliable codec (`libx264`).
-   **WHEN** the re-encode method is used,
    **THEN** the output **SHALL** be a valid MP4 file with the `-movflags +faststart` flag for web-friendliness.
-   **IF** both clipping methods fail,
    **THEN** the job **SHALL** be marked as `failed` with a clear error message indicating the cause.

## 2. Progress Reporting

### User Story

As a user waiting for a clip to be created, I want to see the progress of the operation, so that I know the system is working and can estimate the remaining time.

### Acceptance Criteria

-   **WHEN** the FFmpeg process is running (for either stream-copy or re-encode),
    **THEN** the service **SHALL** parse FFmpeg's `stderr` output to extract progress information.
-   **GIVEN** the total duration of the requested clip segment,
    **THEN** the service **SHALL** calculate the completion percentage based on the `out_time_ms` or `time=` value from FFmpeg's output.
-   **THEN** the service **SHALL** emit progress updates (as a percentage from 0 to 100) to the worker runtime.
-   **WHEN** the clip is successfully generated,
    **THEN** the final progress update **SHALL** be 100%.

## 3. Integration with Worker

### User Story

As a system architect, I want the FFmpeg service to be seamlessly integrated into the worker runtime, so that it can be invoked as part of the overall job processing pipeline.

### Acceptance Criteria

-   **GIVEN** a job that has successfully resolved a source video to a local file path,
    **THEN** the worker **SHALL** invoke the FFmpeg service with the correct arguments (input path, start/end seconds).
-   **WHILE** the FFmpeg service is running,
    **THEN** the worker **SHALL** receive progress updates and persist them to the `jobs` table.
-   **WHEN** the FFmpeg service successfully returns a local path to the final clip,
    **THEN** the worker **SHALL** upload this file to the results storage.
-   **WHEN** the upload is complete,
    **THEN** the worker **SHALL** update the job's status to `done` and record the `resultVideoKey`.
-   **AFTER** the job is complete (or has failed),
    **THEN** the worker **SHALL** ensure all temporary files (source and clip) are cleaned up from the local scratch directory.
````

## File: planning/design.md
````markdown
# Design

artifact_id: be8f9b5e-2a0a-416a-aa62-224390e950a1

## Overview

A Bun + Elysia REST service orchestrates clip jobs backed by Postgres (Drizzle) and a pg-boss queue. Workers resolve media from either uploads (Supabase storage) or YouTube (yt-dlp, feature-flagged), perform fast-path stream-copy clipping when possible, fall back to re-encode for precision, optionally run ASR via Groq Whisper to produce SRT, optionally burn-in subtitles, then store outputs to results bucket and return signed URLs. Observability includes JSON logs, metrics, and a cleanup sweeper for expired artifacts.

## Architecture

### High-level flow

```mermaid
flowchart TD
  A[Client] -->|POST /v1/jobs| B(API)
  B -->|validate & persist| C[(Postgres: jobs, job_events, api_keys)]
  B -->|enqueue| Q[pg-boss]
  A -->|GET /v1/jobs/:id| B
  A -->|GET /v1/jobs/:id/results| B
  B -->|signed URLs| S3[(Supabase/S3 Storage)]
  W[Worker] -->|claim msg| Q
  W -->|resolve source| S3
  W -->|assert safe| DNS{Allowlist + Private IP guard}
  W -->|ffmpeg| P[Local scratch NVMe]
  W -->|ASR Groq| G[Groq Whisper]
  W -->|upload results| S3
  W -->|update status/events| C
  R[Cleanup] -->|sweep expired| S3
  R -->|mark expired| C
```

### Core components

-   API Service (Elysia): endpoints, validation (zod), auth (API keys), health/metrics, optional OpenAPI.
-   Data layer (Drizzle): jobs, job_events, api_keys repositories.
-   Queue adapter: PgBossQueueAdapter with publish/start/subscribe.
-   Worker: consumes queue messages; performs resolve->clip->subs->store; updates status.
-   Storage repo: Supabase client for signed URLs; buckets for sources/results.
-   Media IO resolvers: upload resolver (signed URLs, fetch to scratch, ffprobe), youtube resolver (yt-dlp with allowlist/DNS safety, feature flag).
-   Cleanup: sweeper that deletes expired artifacts from storage and marks rows.
-   Metrics & logging: interfaces provided in src/common.

## Data model (Drizzle / Postgres)

TypeScript types (subset):

```ts
export type JobStatus = 'queued' | 'processing' | 'done' | 'failed';

interface JobRecord {
    id: string;
    sourceType: 'upload' | 'youtube';
    sourceKey?: string; // for upload
    sourceUrl?: string; // for youtube
    startTc: string; // HH:MM:SS(.ms)
    endTc: string; // HH:MM:SS(.ms)
    subtitleLang?: 'auto' | string;
    burnIn?: boolean;
    resultVideoKey?: string;
    resultSrtKey?: string;
    status: JobStatus;
    createdAt: string;
    updatedAt: string;
    expiresAt?: string;
}
```

Drizzle schema (conceptual):

```ts
// enums
declare const jobStatus: 'job_status';

table jobs {
  id uuid pk,
  source_type source_type not null,
  source_key text null,
  source_url text null,
  start_tc text not null,
  end_tc text not null,
  subtitle_lang text null,
  burn_in boolean not null default false,
  result_video_key text null,
  result_srt_key text null,
  status job_status not null default 'queued',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz null
  -- indexes: (status, created_at), expires_at
}

table job_events {
  job_id uuid fk jobs(id) on delete cascade,
  ts timestamptz not null default now(),
  type text not null,     // e.g., 'enqueued','processing','progress','done','failed'
  data jsonb null,
  primary key (job_id, ts)
}

table api_keys {
  id uuid pk,
  name text null,
  secret_hash text not null,
  last_used_at timestamptz null
}
```

## API design (REST)

-   POST /v1/jobs
    -   Auth: Bearer ck*<id>*<secret>
    -   Body: CreateJobInput
    -   202 { id, status }
-   GET /v1/jobs/:id
    -   200 JobRecord + recent events
-   GET /v1/jobs/:id/results
    -   200 { videoUrl, srtUrl? }
    -   409 if not done; 410 if gone
-   POST /v1/uploads/sign
    -   200 { url, method, headers, sourceKey }
-   GET /health
-   GET /metrics
-   GET /openapi.json (flagged)

### Validation & contracts

Use src/contracts/schemas.ts with zod for request/response. Ensure timecode parsing (src/common/time.ts) and state machine (src/common/state.ts) are correct and covered by tests.

## Worker pipeline

1. Resolve source

-   upload: build signed download URL for sourceKey; fetch to scratch; ffprobe for duration/container; enforce caps.
-   youtube: if ENABLE_YTDLP=true and host allowlisted, run yt-dlp to scratch; ffprobe; enforce caps; DNS guard rejects private IPs.

2. Clip

-   Prefer stream-copy: `ffmpeg -ss <start> -to <end> -i input -c copy` when keyframes permit; else precise re-encode with `-preset veryfast -crf 22 -c:v libx264 -c:a aac`.
-   Validate duration tolerance.

3. Subtitles (optional)

-   If subtitleLang provided:
    -   auto: call Groq Whisper API with audio track; save SRT
    -   specific code: passthrough or use model if supported
-   If burnIn=true: render SRT as burned-in variant using `subtitles` filter; else return SRT URL.

4. Store results

-   Upload MP4 (and SRT if present) to results bucket under job-specific prefix; set expiresAt.

5. Update status/events

-   transitions: queued -> processing -> done | failed; retries idempotent with deterministic keys.

## Interfaces (TypeScript)

```ts
export interface QueueAdapter {
    start(): Promise<void>;
    shutdown(): Promise<void>;
    publish(
        msg: { jobId: string; priority?: 'fast' | 'normal' | 'bulk' },
        opts?: { timeoutSec?: number }
    ): Promise<void>;
    subscribe(
        handler: (msg: { jobId: string }) => Promise<void>
    ): Promise<void>;
}

export interface JobsRepository {
    create(
        row: Omit<JobRecord, 'createdAt' | 'updatedAt' | 'status'> &
            Partial<Pick<JobRecord, 'status'>>
    ): Promise<JobRecord>;
    get(id: string): Promise<JobRecord | null>;
    patch(id: string, patch: Partial<JobRecord>): Promise<JobRecord>;
}

export interface JobEventsRepository {
    add(evt: {
        jobId: string;
        type: string;
        data?: Record<string, unknown>;
    }): Promise<void>;
    list(
        jobId: string,
        limit?: number,
        offset?: number
    ): Promise<Array<{ ts: string; type: string; data?: any }>>;
}

export interface StorageRepo {
    signUpload(
        path: string,
        opts: { contentType?: string; expiresSec?: number }
    ): Promise<{
        url: string;
        method: 'PUT' | 'POST';
        headers?: Record<string, string>;
    }>;
    signDownload(
        path: string,
        opts: { expiresSec: number }
    ): Promise<{ url: string }>;
    put(
        path: string,
        data: Blob | ArrayBuffer | ReadableStream,
        opts?: { contentType?: string }
    ): Promise<void>;
    delete(path: string): Promise<void>;
}
```

## Error handling pattern

Use ServiceResult and ServiceError with envelopes. Map domain errors to HTTP:

-   400 VALIDATION_FAILED/BAD_REQUEST
-   401 UNAUTHORIZED
-   403 FORBIDDEN
-   404 NOT_FOUND
-   409 CONFLICT
-   410 GONE
-   429 RATE_LIMITED
-   5xx INTERNAL/UPSTREAM_FAILURE

Include correlationId from request header X-Request-Id or generated UUID. Ensure redactSecrets is applied to logs and error messages. Implement fromException to capture unknowns.

## Security and safety

-   API keys: ck*<uuid>*<secret>; hashed secret stored server-side; PRNG using Bun Crypto; token parsing/redaction utilities.
-   YouTube path: ENABLE_YTDLP gate; ALLOWLIST_HOSTS; DNS resolution with private IP rejection (IPv4 and IPv6 ranges).
-   Storage keys: never log raw URLs; redact query tokens.

## Cleanup strategy

-   Batch scan jobs with expiresAt <= now; for each, attempt storage delete of result\* keys, then mark rows as cleaned/expired.
-   Metrics: counts, durations, errors; rate limiting and backoff.

## Testing strategy

-   Unit tests: timecode parsing/formatting/range; state transitions; redaction; API key packing/unpacking; DNS guards.
-   Integration tests: JobsRepo and JobEventsRepo with a test DB; queue publish/consume; media-io resolvers with mocks.
-   E2E smoke: Create job -> worker processes -> results available; run in CI with tiny sample files.
-   Performance: benchmark ffmpeg stream-copy vs re-encode on sample media; assert SLOs for 10s clips in CI (time-bounded).

## Deployment

-   Single container for API; separate deployment for worker(s); share .env; run cleanup as a scheduled job.
-   Expose metrics endpoint for scraping. Provide minimal README and OpenAPI JSON.
````

## File: planning/requirements.md
````markdown
# Requirements

artifact_id: 7c55e0d3-9bd1-4f75-bf4f-bf9a1f7b2a68

## Introduction

A lean web service for generating short video clips from YouTube links or uploaded media. It optionally generates subtitles (ASR) and can burn them into the video. Results are delivered via short‑lived signed URLs. The system runs as a single-package modular monolith using Bun + Elysia + Drizzle, with Postgres for persistence, pg-boss for queuing, and S3-compatible storage (e.g., Supabase). Focus areas: low latency, observability, operational simplicity, and maintainability.

Assumptions:

-   Runtime: Bun 1.x; TypeScript; Elysia for HTTP API.
-   DB: Postgres + Drizzle ORM; Queue: pg-boss; Storage: Supabase/S3-compatible.
-   ASR: Groq Whisper API for MVP. Feature-flagged YouTube path and host allowlist.
-   Stateless API; workers can scale horizontally; periodic cleanup.

Non-goals for MVP: full NLE, heavy UI, complex multi-tenant auth/quotas beyond API keys.

## Roles

-   API Client (developer, service, internal tools)
-   Operator/Admin (runs jobs, monitors system, bootstrap/cleanup)

## Functional Requirements

1. Create clip job

-   User Story: As an API client, I want to create a clip job from a YouTube URL or uploaded source with start/end timestamps so I can programmatically generate a short shareable clip.
-   Acceptance Criteria:
    -   WHEN a POST /v1/jobs request includes sourceType in {upload,youtube} and a source reference (sourceKey for upload OR sourceUrl for youtube) AND start/end timecodes THEN the API SHALL validate payload and return 202 with a JobRecord {id,status=queued,createdAt}.
    -   IF timecodes are invalid or exceed configured limits THEN the API SHALL respond 400 VALIDATION_FAILED with details.
    -   IF youtube path is disabled by flag or host not in allowlist THEN the API SHALL respond 403 BAD_REQUEST with reason.
    -   IF Authorization is missing/invalid THEN the API SHALL respond 401 UNAUTHORIZED.
    -   IF optional subtitleLang=auto or language code is provided THEN the job SHALL record subtitle generation intent; IF burnIn=true THEN worker SHALL burn subtitles into the output.
    -   IF a client supplies an optional idempotencyKey header for identical payloads within 24h THEN the API SHALL return the original job id/status without duplicating work.

2. Get job status

-   User Story: As an API client, I want to query job status and recent events so I can monitor progress.
-   Acceptance Criteria:
    -   WHEN a GET /v1/jobs/:id request is made THEN the API SHALL return 200 with JobRecord including status in {queued,processing,done,failed}, timestamps, and optional progress/events (last N).
    -   IF job does not exist THEN the API SHALL return 404 NOT_FOUND.
    -   Status transitions SHALL follow a strict state machine and be idempotent.

3. Get results

-   User Story: As an API client, I want signed URLs to download the generated MP4 (and SRT if requested) so I can fetch results without exposing storage credentials.
-   Acceptance Criteria:
    -   WHEN a GET /v1/jobs/:id/results request is made AND job is done THEN the API SHALL return 200 with signed URLs {videoUrl, srtUrl?} that expire per SIGNED_URL_TTL_SEC.
    -   IF job is not done THEN the API SHALL return 409 CONFLICT with current status.
    -   IF results are expired/cleaned up THEN the API SHALL return 410 GONE.

4. Upload support

-   User Story: As an API client, I want to upload source media to managed storage and reference it in job creation.
-   Acceptance Criteria:
    -   WHEN a POST /v1/uploads/sign request is made with {path,size,type} THEN the API SHALL return signed PUT/POST URL (or Supabase signed upload details) and a canonical sourceKey path.
    -   WHEN a POST /v1/jobs is created with sourceType=upload and sourceKey THEN worker SHALL fetch from storage using sourceKey.
    -   IF file exceeds configured MAX_INPUT_MB or duration > MAX_CLIP_INPUT_DURATION_SEC THEN worker/API SHALL fail with 400 VALIDATION_FAILED.

5. Subtitles (ASR)

-   User Story: As an API client, I want optional subtitle generation via ASR.
-   Acceptance Criteria:
    -   IF subtitleLang=auto THEN worker SHALL call Groq Whisper API and save SRT.
    -   IF burnIn=true THEN worker SHALL produce a separate burned-in MP4 variant; otherwise return SRT separately.
    -   IF ASR provider errors THEN job SHALL fail gracefully with UPSTREAM_FAILURE and logs.

6. Clipping behavior

-   User Story: As an API client, I want fast clipping when possible.
-   Acceptance Criteria:
    -   Worker SHALL attempt ffmpeg stream-copy (-c copy with -ss/-to) when GOP alignment allows; otherwise fall back to re-encode with precise cut.
    -   Output container SHALL be MP4 (H.264/AAC), unless input constraints force re-encode.
    -   Output duration SHALL match requested range within ±0.25s when re-encoding, ±1 GOP when stream-copy.

7. Observability

-   User Story: As an operator, I want metrics, health checks, and structured logs.
-   Acceptance Criteria:
    -   WHEN GET /health THEN API SHALL return 200 with shallow DB and queue checks.
    -   WHEN GET /metrics THEN API SHALL return Prometheus-compatible metrics.
    -   Logs SHALL be JSON, redact secrets, and include correlationId.

8. Cleanup

-   User Story: As an operator, I want automated cleanup of expired results and DB rows.
-   Acceptance Criteria:
    -   A scheduled cleanup process SHALL delete storage artifacts and mark rows expired after RETENTION_HOURS.
    -   Cleanup SHALL be idempotent and rate-limited, with metrics reported.

9. Security

-   User Story: As an operator, I want basic API key authentication and network safety for external fetches.
-   Acceptance Criteria:
    -   API SHALL accept ck*<uuid>*<secret> tokens via Authorization: Bearer and validate against api_keys.
    -   YouTube and external fetches SHALL be behind ENABLE_YTDLP flag and ALLOWLIST_HOSTS; DNS resolution SHALL reject private IP ranges.

10. OpenAPI and examples

-   User Story: As an API client, I want an OpenAPI spec and examples for quick integration.
-   Acceptance Criteria:
    -   WHEN ENABLE_OPENAPI=true THEN an OpenAPI JSON SHALL be generated from zod schemas and served at /openapi.json.
    -   README SHALL include quickstart and curl examples.

11. Minimal UI (dogfood)

-   User Story: As an internal user, I want a tiny web UI to submit jobs and download results.
-   Acceptance Criteria:
    -   WHEN a user opens / (or /ui) THEN they SHALL see a simple form to create jobs and a list that polls for status and provides download links.

## Non-Functional Requirements

-   Performance SLOs: P95 ≤ 30s for 30s clip (no subs), ≤ 90s with subs; 99% of jobs within SLO.
-   Reliability: DLQ for exhausted retries; idempotent workers; zero orphaned files after TTL.
-   Scalability: Stateless API; horizontal worker scaling; S3-backed storage; Postgres-based queue.
-   Security: Redaction of secrets in logs; DNS/host allowlist; API key auth.
-   Maintainability: Single .env; clear interfaces; minimal deps; robust tests.
-   Compliance: Respect platform ToS; controlled YouTube path.

## Error Codes (Envelope)

-   BAD_REQUEST, VALIDATION_FAILED, UNAUTHORIZED, FORBIDDEN, NOT_FOUND, CONFLICT, GONE, RATE_LIMITED, UPSTREAM_FAILURE, TIMEOUT, INTERNAL.

## Constraints

-   Clip length cap (CLIP_MAX_DURATION_SEC), MAX_INPUT_MB, MAX_CLIP_INPUT_DURATION_SEC.
-   Storage buckets: SUPABASE_SOURCES_BUCKET, SUPABASE_RESULTS_BUCKET.
-   Queue: pg-boss schema/name; retry policy and visibility timeout.
````

## File: src/api/index.ts
````typescript
import { Elysia, t } from 'elysia';
import cors from '@elysiajs/cors';
import { Schemas, type CreateJobInputType } from '@clipper/contracts';
import { createLogger, readEnv, readIntEnv, requireEnv } from '@clipper/common';
import { DrizzleJobsRepo, DrizzleJobEventsRepo, createDb } from '@clipper/data';
import { PgBossQueueAdapter } from '@clipper/queue';

const log = createLogger((readEnv('LOG_LEVEL') as any) || 'info').with({
    mod: 'api',
});

const jobsRepo = new DrizzleJobsRepo(createDb());
const eventsRepo = new DrizzleJobEventsRepo(createDb());
const queue = new PgBossQueueAdapter({
    connectionString: requireEnv('DATABASE_URL'),
});
await queue.start();

function tcToSec(tc: string) {
    const [hh, mm, rest] = tc.split(':');
    const [ss, ms] = rest?.split('.') || [rest || '0', undefined];
    return (
        Number(hh) * 3600 +
        Number(mm) * 60 +
        Number(ss) +
        (ms ? Number(`0.${ms}`) : 0)
    );
}

export const app = new Elysia()
    .use(cors())
    .get('/healthz', async () => {
        const h = await queue.health();
        return { ok: h.ok, queue: h };
    })
    .get('/metrics/queue', () => queue.getMetrics())
    .post('/api/jobs', async ({ body, set }) => {
        const parsed = Schemas.CreateJobInput.safeParse(body);
        if (!parsed.success) {
            set.status = 400;
            return {
                error: {
                    code: 'VALIDATION_FAILED',
                    message: parsed.error.message,
                },
            };
        }
        const input = parsed.data as CreateJobInputType;
        const id = crypto.randomUUID();
        const startSec = tcToSec(input.start);
        const endSec = tcToSec(input.end);
        if (endSec - startSec > Number(readIntEnv('MAX_CLIP_SECONDS', 120))) {
            set.status = 400;
            return {
                error: {
                    code: 'CLIP_TOO_LONG',
                    message: 'Clip exceeds MAX_CLIP_SECONDS',
                },
            };
        }
        const row = await jobsRepo.create({
            id,
            status: 'queued',
            progress: 0,
            sourceType: input.sourceType,
            sourceKey: input.uploadKey,
            sourceUrl: input.youtubeUrl,
            startSec,
            endSec,
            withSubtitles: input.withSubtitles,
            burnSubtitles: input.burnSubtitles,
            subtitleLang: input.subtitleLang,
            resultVideoKey: undefined,
            resultSrtKey: undefined,
            errorCode: undefined,
            errorMessage: undefined,
            expiresAt: undefined,
        });

        await eventsRepo.add({
            jobId: id,
            ts: new Date().toISOString(),
            type: 'created',
        });
        await queue.publish({ jobId: id, priority: 'normal' });

        return {
            id: row.id,
            status: row.status,
            expiresAt: new Date(
                Date.now() +
                    Number(readIntEnv('RETENTION_HOURS', 72)) * 3600_000
            ).toISOString(),
        };
    });

if (import.meta.main) {
    const port = Number(readIntEnv('PORT', 3000));
    const server = Bun.serve({ fetch: app.fetch, port });
    log.info('API started', { port });
    const stop = async () => {
        log.info('API stopping');
        server.stop(true);
        await queue.shutdown();
        process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}
````

## File: src/asr/formatter.ts
````typescript
import type { AsrProviderSegment } from './provider';

export interface BuildArtifactsOptions {
    includeJson?: boolean;
    mergeGapMs?: number; // default 150ms
    maxLineChars?: number; // default 120
}

export interface BuiltArtifacts {
    srt: string;
    text: string;
    json?: Array<{ start: number; end: number; text: string }>;
}

export function buildArtifacts(
    segments: AsrProviderSegment[],
    opts: BuildArtifactsOptions = {}
): BuiltArtifacts {
    const mergeGapMs = opts.mergeGapMs ?? 150;
    const maxLineChars = opts.maxLineChars ?? 120;

    const norm = normalizeSegments(segments);
    const merged = mergeSegments(norm, mergeGapMs, maxLineChars);
    const srt = buildSrt(merged);
    const text = merged
        .map((s) => s.text)
        .join(' ')
        .trim();
    const out: BuiltArtifacts = { srt, text };
    if (opts.includeJson) {
        out.json = merged.map((s) => ({
            start: s.startSec,
            end: s.endSec,
            text: s.text,
        }));
    }
    return out;
}

function normalizeSegments(inSegs: AsrProviderSegment[]): AsrProviderSegment[] {
    return inSegs
        .map((s) => ({
            startSec: clampNum(s.startSec, 0),
            endSec: clampNum(s.endSec, 0),
            text: sanitizeText(s.text),
            words: s.words?.map((w) => ({
                startSec: clampNum(w.startSec, 0),
                endSec: clampNum(w.endSec, 0),
                text: sanitizeText(w.text),
            })),
        }))
        .filter((s) => s.endSec > s.startSec && s.text.length > 0);
}

function mergeSegments(
    segs: AsrProviderSegment[],
    mergeGapMs: number,
    maxLineChars: number
): AsrProviderSegment[] {
    if (segs.length === 0) return [];
    const out: AsrProviderSegment[] = [];
    let cur: AsrProviderSegment = segs[0]!;
    for (let i = 1; i < segs.length; i++) {
        const next = segs[i]!;
        const gapMs = (next.startSec - cur.endSec) * 1000;
        const combinedLen = (cur.text + ' ' + next.text).length;
        if (gapMs < mergeGapMs && combinedLen <= maxLineChars) {
            cur = {
                startSec: cur.startSec,
                endSec: next.endSec,
                text: (cur.text + ' ' + next.text).trim().replace(/\s+/g, ' '),
            };
        } else {
            out.push(cur);
            cur = next;
        }
    }
    out.push(cur);
    return out;
}

export function buildSrt(segs: AsrProviderSegment[]): string {
    return segs
        .map((s, idx) => {
            const start = formatSrtTime(s.startSec, 'start');
            const end = formatSrtTime(s.endSec, 'end');
            const lines = wrapText(s.text);
            return `${idx + 1}\n${start} --> ${end}\n${lines}\n`;
        })
        .join('\n')
        .trim()
        .concat('\n');
}

function wrapText(t: string, width = 42): string {
    // simple greedy wrap to 1-2 lines if needed
    if (t.length <= width) return t;
    const words = t.split(/\s+/);
    let line = '';
    const lines: string[] = [];
    for (const w of words) {
        if ((line + ' ' + w).trim().length > width && line.length > 0) {
            lines.push(line.trim());
            line = w;
        } else {
            line += (line ? ' ' : '') + w;
        }
    }
    if (line) lines.push(line.trim());
    return lines.slice(0, 2).join('\n');
}

function formatSrtTime(sec: number, kind: 'start' | 'end'): string {
    // start floors ms; end ceils ms to avoid overlaps
    const msFloat = sec * 1000;
    const ms = kind === 'start' ? Math.floor(msFloat) : Math.ceil(msFloat);
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    const mm = (ms % 1000).toString().padStart(3, '0');
    return `${h.toString().padStart(2, '0')}:${m
        .toString()
        .padStart(2, '0')}:${s.toString().padStart(2, '0')},${mm}`;
}

function sanitizeText(t: string): string {
    // Normalize whitespace, remove control chars except \n
    const normalized = (t ?? '').normalize('NFKC');
    const stripped = normalized.replace(/[\u0000-\u001F\u007F]/g, (ch) =>
        ch === '\n' ? '\n' : ' '
    );
    return stripped.trim().replace(/\s+/g, ' ');
}

function clampNum(n: number, min: number): number {
    return Number.isFinite(n) ? Math.max(min, n) : min;
}
````

## File: src/asr/index.ts
````typescript
export * from './provider';
export * from './formatter';
export * from './facade';
````

## File: src/asr/provider.ts
````typescript
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
    transcribe(
        filePath: string,
        opts: { timeoutMs: number; signal?: AbortSignal; languageHint?: string }
    ): Promise<AsrProviderResult>;
}

export class ProviderHttpError extends Error {
    constructor(public status: number, public body?: string) {
        super(`Provider HTTP ${status}`);
        this.name = 'ProviderHttpError';
    }
}

export interface GroqWhisperConfig {
    apiKey?: string;
    model?: string;
    endpoint?: string;
    maxRetries?: number; // number of retry attempts on retryable errors
    initialBackoffMs?: number;
    maxBackoffMs?: number;
}

export class GroqWhisperProvider {
    private readonly apiKey: string;
    private readonly model: string;
    private readonly endpoint: string;
    private readonly maxRetries: number;
    private readonly initialBackoffMs: number;
    private readonly maxBackoffMs: number;

    constructor(cfg: GroqWhisperConfig = {}) {
        const key = cfg.apiKey ?? process.env.GROQ_API_KEY ?? '';
        if (!key) throw new Error('GROQ_API_KEY not configured');
        this.apiKey = key;
        this.model =
            cfg.model ?? process.env.GROQ_MODEL ?? 'whisper-large-v3-turbo';
        this.endpoint =
            cfg.endpoint ??
            'https://api.groq.com/openai/v1/audio/transcriptions';
        this.maxRetries = cfg.maxRetries ?? 3;
        this.initialBackoffMs = cfg.initialBackoffMs ?? 200;
        this.maxBackoffMs = cfg.maxBackoffMs ?? 2000;
    }

    async transcribe(
        filePath: string,
        opts: { timeoutMs: number; signal?: AbortSignal; languageHint?: string }
    ): Promise<AsrProviderResult> {
        const { timeoutMs, signal, languageHint } = opts;

        const controller = new AbortController();
        const signals: AbortSignal[] = [controller.signal];
        if (signal) {
            if (signal.aborted) controller.abort();
            else
                signal.addEventListener('abort', () => controller.abort(), {
                    once: true,
                });
            signals.push(signal);
        }
        const timeout = setTimeout(
            () => controller.abort(),
            Math.max(1, timeoutMs)
        );
        try {
            return await this.requestWithRetry(
                filePath,
                languageHint,
                controller.signal
            );
        } finally {
            clearTimeout(timeout);
        }
    }

    private async requestWithRetry(
        filePath: string,
        languageHint: string | undefined,
        signal: AbortSignal
    ): Promise<AsrProviderResult> {
        let attempt = 0;
        let backoff = this.initialBackoffMs;
        // Prepare payload outside of loop? File object can be reused.
        const file = await this.buildFile(filePath);
        const form = new FormData();
        form.set('model', this.model);
        form.set('response_format', 'verbose_json');
        if (languageHint && languageHint !== 'auto')
            form.set('language', languageHint);
        form.set('file', file);

        // Clone-able body for retries? FormData can be re-sent in Bun; if not, rebuild per attempt.
        const buildBody = async () => {
            // Rebuild to be safe for multiple attempts
            const f = await this.buildFile(filePath);
            const fd = new FormData();
            fd.set('model', this.model);
            fd.set('response_format', 'verbose_json');
            if (languageHint && languageHint !== 'auto')
                fd.set('language', languageHint);
            fd.set('file', f);
            return fd;
        };

        // Retry loop
        // eslint-disable-next-line no-constant-condition
        while (true) {
            try {
                const res = await fetch(this.endpoint, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                    },
                    body: attempt === 0 ? form : await buildBody(),
                    signal,
                });

                if (!res.ok) {
                    if (this.isRetryable(res.status)) {
                        attempt++;
                        if (attempt > this.maxRetries) {
                            throw new ProviderHttpError(
                                res.status,
                                await GroqWhisperProvider.safeText(res)
                            );
                        }
                        const retryAfter = this.parseRetryAfter(
                            res.headers.get('retry-after')
                        );
                        const wait = Math.min(
                            Math.max(retryAfter ?? backoff, 0),
                            this.maxBackoffMs
                        );
                        await GroqWhisperProvider.sleep(wait);
                        backoff = Math.min(backoff * 2, this.maxBackoffMs);
                        continue;
                    }
                    throw new ProviderHttpError(
                        res.status,
                        await GroqWhisperProvider.safeText(res)
                    );
                }

                const json: any = await res.json();
                return this.mapVerboseJson(json);
            } catch (err: any) {
                // Network or abort
                if (err?.name === 'AbortError') throw err;
                attempt++;
                if (attempt > this.maxRetries) {
                    if (err instanceof ProviderHttpError) throw err;
                    throw new ProviderHttpError(0, String(err?.message ?? err));
                }
                const wait = Math.min(backoff, this.maxBackoffMs);
                await GroqWhisperProvider.sleep(wait);
                backoff = Math.min(backoff * 2, this.maxBackoffMs);
            }
        }
    }

    private mapVerboseJson(json: any): AsrProviderResult {
        const segments: AsrProviderSegment[] = Array.isArray(json?.segments)
            ? json.segments.map((s: any) => ({
                  startSec: Number(s.start) || 0,
                  endSec: Number(s.end) || 0,
                  text: String(s.text ?? '')
                      .trim()
                      .replace(/\s+/g, ' '),
                  words: Array.isArray(s.words)
                      ? s.words.map((w: any) => ({
                            startSec: Number(w.start) || 0,
                            endSec: Number(w.end) || 0,
                            text: String(w.word ?? '').trim(),
                        }))
                      : undefined,
              }))
            : [];

        const durationSec = segments.length
            ? segments[segments.length - 1]!.endSec
            : 0;
        return {
            segments,
            detectedLanguage: json?.language,
            modelVersion: json?.model ?? this.model,
            durationSec,
        };
    }

    private async buildFile(filePath: string): Promise<File> {
        const bf = Bun.file(filePath);
        const ab = await bf.arrayBuffer();
        const name = filePath.split('/').pop() || 'audio';
        return new File([ab], name);
    }

    private isRetryable(status: number): boolean {
        return status === 429 || (status >= 500 && status <= 599);
    }

    private parseRetryAfter(val: string | null): number | null {
        if (!val) return null;
        const s = Number(val);
        return Number.isFinite(s) ? Math.max(0, Math.floor(s * 1000)) : null;
    }

    static async safeText(res: Response): Promise<string | undefined> {
        try {
            const t = await res.text();
            // minimal redaction (avoid echoing tokens if ever present)
            return t.replace(/(api|bearer)\s+[a-z0-9-_]+/gi, '$1 ***');
        } catch {
            return undefined;
        }
    }

    static sleep(ms: number) {
        return new Promise((r) => setTimeout(r, ms));
    }
}
````

## File: src/common/tests/common.test.js
````javascript
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../config';
import { parseTimecode, formatTimecode, validateRange } from '../time';
import { transition } from '../state';
describe('config loader', () => {
    it('loads valid config', () => {
        const cfg = loadConfig({
            NODE_ENV: 'test',
            LOG_LEVEL: 'debug',
            SUPABASE_URL: 'https://example.supabase.co',
            SUPABASE_ANON_KEY: 'aaaaaaaaaa',
            ENABLE_YTDLP: 'true',
            CLIP_MAX_DURATION_SEC: '120',
        });
        expect(cfg.ENABLE_YTDLP).toBe(true);
        expect(cfg.CLIP_MAX_DURATION_SEC).toBe(120);
    });
    it('throws on invalid config', () => {
        expect(() => loadConfig({})).toThrow();
    });
});
describe('time utils', () => {
    it('parses and formats timecode', () => {
        const s = parseTimecode('00:00:01.250');
        expect(s).toBeCloseTo(1.25, 3);
        expect(formatTimecode(s)).toBe('00:00:01.250');
    });
    it('validates range with cap', () => {
        const ok = validateRange('00:00:00', '00:00:10', {
            maxDurationSec: 15,
        });
        expect(ok.ok).toBe(true);
        const bad = validateRange('00:00:10', '00:00:09', {
            maxDurationSec: 15,
        });
        expect(bad.ok).toBe(false);
    });
});
describe('state machine', () => {
    it('allows valid transitions', () => {
        const t = transition('queued', 'processing');
        expect(t.from).toBe('queued');
        expect(t.to).toBe('processing');
    });
    it('rejects invalid transitions', () => {
        expect(() => transition('queued', 'done')).toThrow();
    });
});
````

## File: src/common/config.ts
````typescript
import { z } from 'zod';

export const ConfigSchema = z.object({
    NODE_ENV: z
        .enum(['development', 'test', 'production'])
        .default('development'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    SUPABASE_URL: z.string().url(),
    SUPABASE_ANON_KEY: z.string().min(10),
    QUEUE_URL: z.string().url().optional(),
    ENABLE_YTDLP: z.boolean().default(false),
    CLIP_MAX_DURATION_SEC: z.number().int().positive().default(120),
    // Media IO / Source Resolver
    SCRATCH_DIR: z.string().default('/tmp/ytc'),
    MAX_INPUT_MB: z.number().int().positive().default(1024),
    MAX_CLIP_INPUT_DURATION_SEC: z.number().int().positive().default(7200),
    ALLOWLIST_HOSTS: z.string().optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(
    env: Record<string, string | undefined> = process.env
): AppConfig {
    const parsed = ConfigSchema.safeParse({
        ...env,
        ENABLE_YTDLP: env.ENABLE_YTDLP === 'true',
        CLIP_MAX_DURATION_SEC: env.CLIP_MAX_DURATION_SEC
            ? Number(env.CLIP_MAX_DURATION_SEC)
            : undefined,
        MAX_INPUT_MB: env.MAX_INPUT_MB ? Number(env.MAX_INPUT_MB) : undefined,
        MAX_CLIP_INPUT_DURATION_SEC: env.MAX_CLIP_INPUT_DURATION_SEC
            ? Number(env.MAX_CLIP_INPUT_DURATION_SEC)
            : undefined,
    });
    if (!parsed.success) {
        const details = parsed.error.flatten();
        const redacted = Object.fromEntries(
            Object.entries(env).map(([k, v]) => [
                k,
                k.includes('KEY') ? '***' : v,
            ])
        );
        throw new Error(
            'Invalid configuration: ' +
                JSON.stringify({ details, env: redacted })
        );
    }
    return parsed.data;
}
````

## File: src/common/env.ts
````typescript
/**
 * Robust env access that prefers Bun.env (if present) and falls back to process.env.
 * This avoids jank when running under Bun vs Vitest's node environment.
 */
export function readEnv(key: string): string | undefined {
    // @ts-ignore
    const bunEnv =
        typeof Bun !== 'undefined'
            ? (Bun.env as Record<string, string | undefined>)
            : undefined;
    return bunEnv?.[key] ?? process.env[key];
}

export function requireEnv(key: string): string {
    const val = readEnv(key);
    if (val == null || val === '') {
        throw new Error(`Missing required env: ${key}`);
    }
    return val;
}

export function readIntEnv(
    key: string,
    defaultValue?: number
): number | undefined {
    const v = readEnv(key);
    if (v == null || v === '') return defaultValue;
    const n = Number(v);
    if (Number.isNaN(n)) return defaultValue;
    return n;
}
````

## File: src/common/errors.ts
````typescript
import { redactSecrets } from './redact';
export type ServiceErrorCode =
    | 'BAD_REQUEST'
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'RATE_LIMITED'
    | 'INTERNAL'
    | 'INVALID_STATE'
    | 'VALIDATION_FAILED';

export interface ErrorEnvelope {
    code: ServiceErrorCode;
    message: string;
    details?: unknown;
    correlationId?: string;
}

export class ServiceError extends Error {
    constructor(
        public code: ServiceErrorCode,
        message: string,
        public details?: unknown
    ) {
        super(message);
        this.name = 'ServiceError';
    }
}

export type Ok<T> = { ok: true; value: T };
export type Err = { ok: false; error: ErrorEnvelope };
export type ServiceResult<T> = Ok<T> | Err;

export function ok<T>(value: T): Ok<T> {
    return { ok: true, value };
}
export function err(
    code: ServiceErrorCode,
    message: string,
    details?: unknown,
    correlationId?: string
): Err {
    // Redact secrets in message/details
    return {
        ok: false,
        error: {
            code,
            message: redactSecrets(message),
            details: redactSecrets(details),
            correlationId,
        },
    };
}

export function fromException(e: unknown, correlationId?: string): Err {
    if (e instanceof ServiceError) {
        return err(e.code, e.message, e.details, correlationId);
    }
    const message = e instanceof Error ? e.message : String(e);
    return err('INTERNAL', message, undefined, correlationId);
}
````

## File: src/common/index.ts
````typescript
export * from './config';
export * from './logger';
export * from './errors';
export * from './time';
export * from './state';
export * from './env';
export * from './metrics';
export * from './redact';
````

## File: src/common/logger.ts
````typescript
import { redactSecrets } from './redact';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
    level: LogLevel;
    with(fields: Record<string, unknown>): Logger;
    debug(msg: string, fields?: Record<string, unknown>): void;
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
}

function emit(
    level: LogLevel,
    base: Record<string, unknown>,
    msg: string,
    fields?: Record<string, unknown>
) {
    const line = {
        level,
        ts: new Date().toISOString(),
        msg: redactSecrets(msg),
        ...redactSecrets(base),
        ...redactSecrets(fields ?? {}),
    };
    // eslint-disable-next-line no-console
    console[level === 'debug' ? 'log' : level](JSON.stringify(line));
}

export function createLogger(
    level: LogLevel = 'info',
    base: Record<string, unknown> = {}
): Logger {
    return {
        level,
        with(additional) {
            return createLogger(level, { ...base, ...additional });
        },
        debug(msg, fields) {
            if (['debug'].includes(level)) emit('debug', base, msg, fields);
        },
        info(msg, fields) {
            if (['debug', 'info'].includes(level))
                emit('info', base, msg, fields);
        },
        warn(msg, fields) {
            if (['debug', 'info', 'warn'].includes(level))
                emit('warn', base, msg, fields);
        },
        error(msg, fields) {
            emit('error', base, msg, fields);
        },
    };
}
````

## File: src/common/metrics.ts
````typescript
export type MetricLabels = Record<string, string | number>;

export interface Metrics {
    inc(name: string, value?: number, labels?: MetricLabels): void;
    observe(name: string, value: number, labels?: MetricLabels): void;
}

export class InMemoryMetrics implements Metrics {
    counters = new Map<string, number>();
    histograms = new Map<string, number[]>();
    inc(name: string, value = 1, labels?: MetricLabels) {
        const key = keyWithLabels(name, labels);
        this.counters.set(key, (this.counters.get(key) ?? 0) + value);
    }
    observe(name: string, value: number, labels?: MetricLabels) {
        const key = keyWithLabels(name, labels);
        const arr = this.histograms.get(key) ?? [];
        arr.push(value);
        this.histograms.set(key, arr);
    }
}

export const noopMetrics: Metrics = {
    inc() {},
    observe() {},
};

function keyWithLabels(name: string, labels?: MetricLabels) {
    if (!labels) return name;
    const parts = Object.entries(labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
    return `${name}{${parts}}`;
}
````

## File: src/common/redact.ts
````typescript
// Simple secret redaction utilities for logs and error messages.
// - Redacts API tokens in common places (Authorization headers, query params)
// - Redacts our ck_<id>_<secret> API key format
// - Redacts object properties whose keys look sensitive (token, secret, key, password)

const SENSITIVE_KEY_REGEX =
    /^(?:authorization|password|pass|secret|token|api[_-]?key|key)$/i;

function redactString(input: string): string {
    let out = input;
    // Bearer tokens
    out = out.replace(
        /Bearer\s+[A-Za-z0-9\-\._~\+\/]+=*/gi,
        'Bearer [REDACTED]'
    );
    // Query params like ?apikey=...&token=...
    out = out.replace(
        /([?&](?:api|apikey|token|key|secret)=)([^&#\s]+)/gi,
        '$1[REDACTED]'
    );
    // Our API key format: ck_<uuid>_<base64url>
    out = out.replace(
        /\bck_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]+)\b/gi,
        (_m, id) => `ck_${id}_[REDACTED]`
    );
    return out;
}

function redactArray(arr: unknown[]): unknown[] {
    return arr.map((v) => redactSecrets(v));
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = Array.isArray(obj) ? {} : {};
    for (const [k, v] of Object.entries(obj)) {
        if (SENSITIVE_KEY_REGEX.test(k)) {
            out[k] = '[REDACTED]';
            continue;
        }
        out[k] = redactSecrets(v);
    }
    return out;
}

export function redactSecrets<T = unknown>(value: T): T {
    if (value == null) return value;
    if (typeof value === 'string') return redactString(value) as unknown as T;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof Error) {
        const e = value as Error;
        const copy = new Error(redactString(e.message));
        (copy as any).name = e.name;
        (copy as any).stack = e.stack ? redactString(e.stack) : undefined;
        return copy as unknown as T;
    }
    if (Array.isArray(value)) return redactArray(value) as unknown as T;
    if (typeof value === 'object')
        return redactObject(value as any) as unknown as T;
    return value;
}

// Convenience for explicit string redaction when needed
export function redactText(text: string): string {
    return redactString(text);
}
````

## File: src/common/state.ts
````typescript
import type { JobStatus } from '@clipper/contracts';
import { ServiceError } from './errors';

export type Transition = {
    from: JobStatus;
    to: JobStatus;
    at: string;
    reason?: string;
};

const allowed: Record<JobStatus, JobStatus[]> = {
    queued: ['processing'],
    processing: ['done', 'failed'],
    done: [],
    failed: [],
};

export function transition(
    current: JobStatus,
    to: JobStatus,
    reason?: string
): Transition {
    if (current === to && (to === 'done' || to === 'failed')) {
        return { from: current, to, at: new Date().toISOString(), reason };
    }
    const next = allowed[current] || [];
    if (!next.includes(to)) {
        throw new ServiceError(
            'INVALID_STATE',
            `Invalid transition ${current} -> ${to}`
        );
    }
    return { from: current, to, at: new Date().toISOString(), reason };
}
````

## File: src/common/time.ts
````typescript
export function parseTimecode(tc: string): number {
    const m = tc.match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (!m) throw new Error('Invalid timecode');
    const [hh, mm, ss, ms] = [
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
        m[4] ? Number(m[4].padEnd(3, '0')) : 0,
    ];
    return hh * 3600 + mm * 60 + ss + ms / 1000;
}

export function formatTimecode(seconds: number): string {
    const sign = seconds < 0 ? '-' : '';
    const s = Math.abs(seconds);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    const core = `${hh.toString().padStart(2, '0')}:${mm
        .toString()
        .padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
    return ms
        ? `${sign}${core}.${ms.toString().padStart(3, '0')}`
        : `${sign}${core}`;
}

export function validateRange(
    startTc: string,
    endTc: string,
    opts: { maxDurationSec: number }
) {
    const start = parseTimecode(startTc);
    const end = parseTimecode(endTc);
    if (!(start < end))
        return { ok: false as const, reason: 'start_not_before_end' };
    if (end - start > opts.maxDurationSec)
        return { ok: false as const, reason: 'duration_exceeds_cap' };
    return { ok: true as const, startSec: start, endSec: end };
}
````

## File: src/contracts/index.ts
````typescript
export type {
    SourceType,
    JobStatus,
    CreateJobInput as CreateJobInputType,
    JobRecord,
} from './types';

export * as Schemas from './schemas';
export { maybeGenerateOpenApi } from './openapi';
````

## File: src/contracts/schemas.ts
````typescript
import { z } from 'zod';
import type { CreateJobInput as CreateJobInputType } from './types';

export const timecode = z
    .string()
    .regex(/^\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/, 'Expected HH:MM:SS(.ms)');

export const SourceType = z.enum(['upload', 'youtube']);
export const JobStatus = z.enum(['queued', 'processing', 'done', 'failed']);

export const CreateJobInput = z
    .object({
        sourceType: SourceType,
        youtubeUrl: z.string().url().optional(),
        uploadKey: z.string().min(1).optional(),
        start: timecode,
        end: timecode,
        withSubtitles: z.boolean().default(false),
        burnSubtitles: z.boolean().default(false),
        subtitleLang: z
            .union([z.literal('auto'), z.string().min(2)])
            .optional(),
    })
    .superRefine((val: CreateJobInputType, ctx) => {
        if (val.sourceType === 'upload' && !val.uploadKey) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'uploadKey required for sourceType=upload',
                path: ['uploadKey'],
            });
        }
        if (val.sourceType === 'youtube' && !val.youtubeUrl) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'youtubeUrl required for sourceType=youtube',
                path: ['youtubeUrl'],
            });
        }
    });

export const JobRecord = z.object({
    id: z.string().uuid(),
    status: JobStatus,
    progress: z.number().min(0).max(100),
    resultVideoKey: z.string().optional(),
    resultSrtKey: z.string().optional(),
    error: z.string().optional(),
    expiresAt: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
````

## File: src/contracts/types.ts
````typescript
export type SourceType = 'upload' | 'youtube';
export type JobStatus = 'queued' | 'processing' | 'done' | 'failed';

export interface CreateJobInput {
    sourceType: SourceType;
    youtubeUrl?: string;
    uploadKey?: string; // Supabase path
    start: string; // HH:MM:SS(.ms)
    end: string; // HH:MM:SS(.ms)
    withSubtitles: boolean;
    burnSubtitles: boolean;
    subtitleLang?: 'auto' | string;
}

export interface JobRecord {
    id: string;
    status: JobStatus;
    progress: number; // 0..100
    resultVideoKey?: string;
    resultSrtKey?: string;
    error?: string;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
}
````

## File: src/data/drizzle/meta/0000_snapshot.json
````json
{
  "id": "8b6622c6-d409-4478-942e-59689bb2473a",
  "prevId": "00000000-0000-0000-0000-000000000000",
  "version": "7",
  "dialect": "postgresql",
  "tables": {
    "public.api_keys": {
      "name": "api_keys",
      "schema": "",
      "columns": {
        "id": {
          "name": "id",
          "type": "uuid",
          "primaryKey": true,
          "notNull": true
        },
        "name": {
          "name": "name",
          "type": "text",
          "primaryKey": false,
          "notNull": true
        },
        "key_hash": {
          "name": "key_hash",
          "type": "text",
          "primaryKey": false,
          "notNull": true
        },
        "revoked": {
          "name": "revoked",
          "type": "boolean",
          "primaryKey": false,
          "notNull": true,
          "default": false
        },
        "created_at": {
          "name": "created_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        },
        "last_used_at": {
          "name": "last_used_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": false
        }
      },
      "indexes": {},
      "foreignKeys": {},
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.job_events": {
      "name": "job_events",
      "schema": "",
      "columns": {
        "job_id": {
          "name": "job_id",
          "type": "uuid",
          "primaryKey": false,
          "notNull": true
        },
        "ts": {
          "name": "ts",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        },
        "type": {
          "name": "type",
          "type": "text",
          "primaryKey": false,
          "notNull": true
        },
        "data": {
          "name": "data",
          "type": "jsonb",
          "primaryKey": false,
          "notNull": false
        }
      },
      "indexes": {
        "idx_job_events_job_id_ts": {
          "name": "idx_job_events_job_id_ts",
          "columns": [
            {
              "expression": "job_id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "ts",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            }
          ],
          "isUnique": false,
          "concurrently": false,
          "method": "btree",
          "with": {}
        }
      },
      "foreignKeys": {
        "job_events_job_id_jobs_id_fk": {
          "name": "job_events_job_id_jobs_id_fk",
          "tableFrom": "job_events",
          "tableTo": "jobs",
          "columnsFrom": [
            "job_id"
          ],
          "columnsTo": [
            "id"
          ],
          "onDelete": "cascade",
          "onUpdate": "no action"
        }
      },
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.jobs": {
      "name": "jobs",
      "schema": "",
      "columns": {
        "id": {
          "name": "id",
          "type": "uuid",
          "primaryKey": true,
          "notNull": true
        },
        "status": {
          "name": "status",
          "type": "job_status",
          "typeSchema": "public",
          "primaryKey": false,
          "notNull": true,
          "default": "'queued'"
        },
        "progress": {
          "name": "progress",
          "type": "integer",
          "primaryKey": false,
          "notNull": true,
          "default": 0
        },
        "source_type": {
          "name": "source_type",
          "type": "source_type",
          "typeSchema": "public",
          "primaryKey": false,
          "notNull": true
        },
        "source_key": {
          "name": "source_key",
          "type": "text",
          "primaryKey": false,
          "notNull": false
        },
        "source_url": {
          "name": "source_url",
          "type": "text",
          "primaryKey": false,
          "notNull": false
        },
        "start_sec": {
          "name": "start_sec",
          "type": "integer",
          "primaryKey": false,
          "notNull": true
        },
        "end_sec": {
          "name": "end_sec",
          "type": "integer",
          "primaryKey": false,
          "notNull": true
        },
        "with_subtitles": {
          "name": "with_subtitles",
          "type": "boolean",
          "primaryKey": false,
          "notNull": true,
          "default": false
        },
        "burn_subtitles": {
          "name": "burn_subtitles",
          "type": "boolean",
          "primaryKey": false,
          "notNull": true,
          "default": false
        },
        "subtitle_lang": {
          "name": "subtitle_lang",
          "type": "text",
          "primaryKey": false,
          "notNull": false
        },
        "result_video_key": {
          "name": "result_video_key",
          "type": "text",
          "primaryKey": false,
          "notNull": false
        },
        "result_srt_key": {
          "name": "result_srt_key",
          "type": "text",
          "primaryKey": false,
          "notNull": false
        },
        "error_code": {
          "name": "error_code",
          "type": "text",
          "primaryKey": false,
          "notNull": false
        },
        "error_message": {
          "name": "error_message",
          "type": "text",
          "primaryKey": false,
          "notNull": false
        },
        "created_at": {
          "name": "created_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        },
        "updated_at": {
          "name": "updated_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        },
        "expires_at": {
          "name": "expires_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": false
        }
      },
      "indexes": {
        "idx_jobs_status_created_at": {
          "name": "idx_jobs_status_created_at",
          "columns": [
            {
              "expression": "status",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "created_at",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            }
          ],
          "isUnique": false,
          "concurrently": false,
          "method": "btree",
          "with": {}
        },
        "idx_jobs_expires_at": {
          "name": "idx_jobs_expires_at",
          "columns": [
            {
              "expression": "expires_at",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            }
          ],
          "isUnique": false,
          "concurrently": false,
          "method": "btree",
          "with": {}
        }
      },
      "foreignKeys": {},
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    }
  },
  "enums": {
    "public.job_status": {
      "name": "job_status",
      "schema": "public",
      "values": [
        "queued",
        "processing",
        "done",
        "failed"
      ]
    },
    "public.source_type": {
      "name": "source_type",
      "schema": "public",
      "values": [
        "upload",
        "youtube"
      ]
    }
  },
  "schemas": {},
  "sequences": {},
  "roles": {},
  "policies": {},
  "views": {},
  "_meta": {
    "columns": {},
    "schemas": {},
    "tables": {}
  }
}
````

## File: src/data/drizzle/0000_tense_yellow_claw.sql
````sql
CREATE TYPE "public"."job_status" AS ENUM('queued', 'processing', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('upload', 'youtube');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"job_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"source_type" "source_type" NOT NULL,
	"source_key" text,
	"source_url" text,
	"start_sec" integer NOT NULL,
	"end_sec" integer NOT NULL,
	"with_subtitles" boolean DEFAULT false NOT NULL,
	"burn_subtitles" boolean DEFAULT false NOT NULL,
	"subtitle_lang" text,
	"result_video_key" text,
	"result_srt_key" text,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_job_events_job_id_ts" ON "job_events" USING btree ("job_id","ts");--> statement-breakpoint
CREATE INDEX "idx_jobs_status_created_at" ON "jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_jobs_expires_at" ON "jobs" USING btree ("expires_at");
````

## File: src/data/drizzle/0001_asr_jobs.sql
````sql
-- ASR tables migration
CREATE TYPE "public"."asr_job_status" AS ENUM('queued','processing','done','failed');

CREATE TABLE "asr_jobs" (
    "id" uuid PRIMARY KEY NOT NULL,
    "clip_job_id" uuid,
    "source_type" text NOT NULL,
    "source_key" text,
    "media_hash" text NOT NULL,
    "model_version" text NOT NULL,
    "language_hint" text,
    "detected_language" text,
    "duration_sec" integer,
    "status" "asr_job_status" DEFAULT 'queued' NOT NULL,
    "error_code" text,
    "error_message" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    "completed_at" timestamp with time zone,
    "expires_at" timestamp with time zone
);
ALTER TABLE "asr_jobs" ADD CONSTRAINT "asr_jobs_clip_job_id_jobs_id_fk" FOREIGN KEY ("clip_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "idx_asr_jobs_status_created_at" ON "asr_jobs" USING btree ("status","created_at");
CREATE INDEX "idx_asr_jobs_expires_at" ON "asr_jobs" USING btree ("expires_at");
-- unique reuse index (partial)
CREATE UNIQUE INDEX "uq_asr_jobs_media_model_done" ON "asr_jobs" ("media_hash","model_version") WHERE status = 'done';

CREATE TABLE "asr_artifacts" (
    "asr_job_id" uuid NOT NULL,
    "kind" text NOT NULL,
    "storage_key" text NOT NULL,
    "size_bytes" integer,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT asr_artifacts_pk PRIMARY KEY ("asr_job_id","kind"),
    CONSTRAINT asr_artifacts_asr_job_id_asr_jobs_id_fk FOREIGN KEY ("asr_job_id") REFERENCES "public"."asr_jobs"("id") ON DELETE cascade ON UPDATE no action
);
````

## File: src/data/scripts/admin-jobs.ts
````typescript
import { eq, inArray } from 'drizzle-orm';
import { createDb } from '../db/connection';
import { jobs } from '../db/schema';
import { readEnv } from '@clipper/common';

type CloneCandidate = {
    id: string;
    status: string;
    sourceType: 'upload' | 'youtube';
    sourceKey: string | null;
    sourceUrl: string | null;
    startSec: number;
    endSec: number;
    withSubtitles: boolean;
    burnSubtitles: boolean;
    subtitleLang: string | null;
};

async function main() {
    // Inputs
    const argIds = process.argv.slice(2).filter(Boolean);
    const envIds = (readEnv('JOB_IDS') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const ids = (argIds.length ? argIds : envIds).filter(
        (v, i, a) => a.indexOf(v) === i
    );
    if (ids.length === 0) {
        console.error(
            'Usage: bun src/scripts/admin-jobs.ts <jobId...>\n  or: JOB_IDS="id1,id2" bun src/scripts/admin-jobs.ts'
        );
        process.exit(1);
    }
    const REQUEUE = (readEnv('REQUEUE') || 'true').toLowerCase() !== 'false';

    const db = createDb();

    // Fetch rows first (to know what to clone)
    const rows =
        ids.length === 1
            ? await db.select().from(jobs).where(eq(jobs.id, ids[0]!))
            : await db
                  .select()
                  .from(jobs)
                  .where(inArray(jobs.id, ids as string[]));

    if (rows.length === 0) {
        console.warn('[admin-jobs] No matching jobs found for provided IDs');
    }

    // Pick the first youtube job among the set as the clone candidate (if any)
    const yt: CloneCandidate | undefined = rows
        .map((r) => ({
            id: r.id,
            status: r.status,
            sourceType: r.sourceType,
            sourceKey: r.sourceKey,
            sourceUrl: r.sourceUrl,
            startSec: r.startSec,
            endSec: r.endSec,
            withSubtitles: r.withSubtitles,
            burnSubtitles: r.burnSubtitles,
            subtitleLang: r.subtitleLang,
        }))
        .find((r) => r.sourceType === 'youtube');

    // Delete all requested jobs; job_events cascades on delete
    const delCount = await db
        .delete(jobs)
        .where(
            ids.length === 1
                ? eq(jobs.id, ids[0]!)
                : inArray(jobs.id, ids as string[])
        );

    console.log('[admin-jobs] Deleted jobs', { ids, delCount });

    // Optionally requeue the youtube job by cloning its fields into a fresh row
    if (REQUEUE && yt) {
        const newId = crypto.randomUUID();
        const createdRows = await db
            .insert(jobs)
            .values({
                id: newId,
                status: 'queued',
                progress: 0,
                sourceType: 'youtube',
                sourceKey: yt.sourceKey,
                sourceUrl: yt.sourceUrl,
                startSec: yt.startSec,
                endSec: yt.endSec,
                withSubtitles: yt.withSubtitles,
                burnSubtitles: yt.burnSubtitles,
                subtitleLang: yt.subtitleLang,
                resultVideoKey: null,
                resultSrtKey: null,
                errorCode: null,
                errorMessage: null,
            })
            .returning();
        const created = createdRows[0]!;
        console.log('[admin-jobs] Requeued YouTube job', {
            oldId: yt.id,
            newId: created.id,
            sourceUrl: created.sourceUrl,
        });
    } else if (!yt) {
        console.log('[admin-jobs] No YouTube job among deleted IDs to requeue');
    } else {
        console.log('[admin-jobs] REQUEUE=false; skipping requeue');
    }
}

if (import.meta.main) {
    main().catch((err) => {
        console.error('[admin-jobs] Failed', err);
        process.exit(1);
    });
}
````

## File: src/data/scripts/bootstrap-storage.ts
````typescript
import { createClient } from '@supabase/supabase-js';
import { readEnv } from '@clipper/common';

export type BootstrapOptions = {
    url?: string;
    serviceRoleKey?: string;
    bucket: string;
    createPrefixes?: boolean; // creates sources/.keep and results/.keep
};

export async function bootstrapStorage(opts: BootstrapOptions) {
    const url = opts.url ?? readEnv('SUPABASE_URL');
    const key = opts.serviceRoleKey ?? readEnv('SUPABASE_SERVICE_ROLE_KEY');
    const bucket = opts.bucket;
    if (!url || !key) throw new Error('Missing SUPABASE_URL or SERVICE_ROLE');
    if (!bucket) throw new Error('Missing bucket name');

    const supabase = createClient(url, key);

    // Ensure bucket exists
    const { data: buckets, error: listErr } =
        await supabase.storage.listBuckets();
    if (listErr) throw new Error(`listBuckets failed: ${listErr.message}`);
    const exists = (buckets ?? []).some((b) => b.name === bucket);
    if (!exists) {
        const { error } = await supabase.storage.createBucket(bucket, {
            public: false,
        });
        if (error && !String(error.message).includes('already exists')) {
            throw new Error(`createBucket failed: ${error.message}`);
        }
    }

    // Optionally create prefix keep files
    if (opts.createPrefixes) {
        const mk = async (path: string) =>
            supabase.storage
                .from(bucket)
                .upload(path, new Blob([new Uint8Array(0)]), {
                    upsert: true,
                    contentType: 'application/octet-stream',
                })
                .then(({ error }) => {
                    if (
                        error &&
                        !String(error.message).includes('already exists')
                    )
                        throw new Error(
                            `upload ${path} failed: ${error.message}`
                        );
                });
        await mk('sources/.keep');
        await mk('results/.keep');
    }
}

// CLI entry
if (import.meta.main) {
    const bucket = readEnv('SUPABASE_STORAGE_BUCKET');
    bootstrapStorage({
        bucket: bucket!,
        createPrefixes: true,
    })
        .then(() => {
            console.log('Storage bootstrap complete');
        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
````

## File: src/data/scripts/cleanup.ts
````typescript
import { cleanupExpiredJobs } from '../cleanup';
import { createSupabaseStorageRepo } from '../storage';
import { readEnv, readIntEnv } from '@clipper/common';
import { createLogger } from '@clipper/common/logger';

const DRY_RUN =
    (readEnv('CLEANUP_DRY_RUN') ?? 'true').toLowerCase() !== 'false';
const BATCH = readIntEnv('CLEANUP_BATCH_SIZE', 100) ?? 100;
const RATE_DELAY = readIntEnv('CLEANUP_RATE_LIMIT_MS', 0) ?? 0;
const USE_STORAGE =
    (readEnv('CLEANUP_STORAGE') ?? 'true').toLowerCase() === 'true';

async function main() {
    const logger = createLogger((readEnv('LOG_LEVEL') as any) ?? 'info');
    const storage = USE_STORAGE
        ? (() => {
              try {
                  return createSupabaseStorageRepo();
              } catch {
                  return null;
              }
          })()
        : null;
    const res = await cleanupExpiredJobs({
        dryRun: DRY_RUN,
        batchSize: BATCH,
        rateLimitDelayMs: RATE_DELAY,
        storage,
        logger,
    });
    logger.info('cleanup finished', res as any);
}

if (import.meta.main) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
````

## File: src/data/scripts/seed.ts
````typescript
import { createDb } from '../db/connection';
import { jobs } from '../db/schema';

export async function seedMinimal() {
    const db = createDb();
    const id = crypto.randomUUID();
    await db.insert(jobs).values({
        id,
        status: 'queued',
        progress: 0,
        sourceType: 'upload',
        startSec: 0,
        endSec: 5,
        withSubtitles: false,
        burnSubtitles: false,
    });
    console.log('Seeded job:', id);
}

if (import.meta.main) {
    seedMinimal().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
````

## File: src/data/api-keys.ts
````typescript
import { createDb } from './db/connection';
import { apiKeys } from './db/schema';
import { eq } from 'drizzle-orm';

export interface ApiKeyRecord {
    id: string;
    name: string;
    revoked: boolean;
    createdAt: string;
    lastUsedAt?: string;
}

export interface ApiKeysRepository {
    issue(name: string): Promise<{ id: string; name: string; token: string }>;
    verify(token: string): Promise<ApiKeyRecord | null>;
    revoke(id: string): Promise<void>;
}

function ensureBunPassword() {
    const bun: any = (globalThis as any).Bun;
    if (!bun?.password) {
        throw new Error('BUN_PASSWORD_UNAVAILABLE: Bun.password is required');
    }
    return bun.password as {
        hash: (pw: string | ArrayBufferView, opts?: any) => Promise<string>;
        verify: (
            pw: string | ArrayBufferView,
            hash: string
        ) => Promise<boolean>;
    };
}

function generateTokenParts() {
    const id = crypto.randomUUID();
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const secret = Buffer.from(bytes).toString('base64url');
    return { id, secret };
}

function packToken(id: string, secret: string) {
    return `ck_${id}_${secret}`;
}

function unpackToken(token: string): { id: string; secret: string } | null {
    if (!token.startsWith('ck_')) return null;
    const parts = token.split('_');
    if (parts.length < 3) return null;
    const id = parts[1]!;
    const secret = parts.slice(2).join('_');
    if (!id || !secret) return null;
    return { id, secret };
}

export class DrizzleApiKeysRepo implements ApiKeysRepository {
    constructor(private readonly db = createDb()) {}

    async issue(
        name: string
    ): Promise<{ id: string; name: string; token: string }> {
        const { id, secret } = generateTokenParts();
        const token = packToken(id, secret);
        const bunPwd = ensureBunPassword();
        const hash = await bunPwd.hash(secret);
        await this.db
            .insert(apiKeys)
            .values({ id, name, keyHash: hash, revoked: false });
        return { id, name, token };
    }

    async verify(token: string): Promise<ApiKeyRecord | null> {
        const parsed = unpackToken(token);
        if (!parsed) return null;
        const [rec] = await this.db
            .select()
            .from(apiKeys)
            .where(eq(apiKeys.id, parsed.id))
            .limit(1);
        if (!rec || rec.revoked) return null;
        const bunPwd = ensureBunPassword();
        const ok = await bunPwd.verify(parsed.secret, rec.keyHash);
        if (!ok) return null;
        await this.db
            .update(apiKeys)
            .set({ lastUsedAt: new Date() })
            .where(eq(apiKeys.id, rec.id));
        return {
            id: rec.id,
            name: rec.name,
            revoked: rec.revoked,
            createdAt: rec.createdAt.toISOString(),
            lastUsedAt: rec.lastUsedAt?.toISOString(),
        };
    }

    async revoke(id: string): Promise<void> {
        await this.db
            .update(apiKeys)
            .set({ revoked: true })
            .where(eq(apiKeys.id, id));
    }
}
````

## File: src/data/index.ts
````typescript
export * from './repo';
export * as dbSchema from './db/schema';
export * from './db/connection';
export * from './db/repos';
export * from './storage';
export * from './cleanup';
export * from './api-keys';
export * from './media-io';
export { resolveUploadSource } from './media-io-upload';
export { resolveYouTubeSource } from './media-io-youtube';
````

## File: src/data/media-io.ts
````typescript
export interface ResolveResult {
    localPath: string;
    cleanup: () => Promise<void>;
    meta: { durationSec: number; sizeBytes: number; container?: string };
}

export interface SourceResolver {
    resolve(job: {
        id: string;
        sourceType: 'upload' | 'youtube';
        sourceKey?: string; // Supabase path (for uploads)
        sourceUrl?: string; // External URL (YouTube)
    }): Promise<ResolveResult>;
}
````

## File: src/ffmpeg/index.ts
````typescript
// Public barrel for ffmpeg clipper
export * from './types';
export * from './progress';
export * from './clipper';
````

## File: src/ffmpeg/types.ts
````typescript
/**
 * Types for the FFmpeg clipping service.
 */
export interface ClipResult {
    /** Local filesystem path to the generated clip file (mp4). */
    localPath: string;
    /** Async iterable emitting progress percentages (0..100). */
    progress$: AsyncIterable<number>;
}

export interface ClipArgs {
    /** Source local file path (must exist and be readable). */
    input: string;
    /** Inclusive start time in seconds. */
    startSec: number;
    /** Exclusive end time in seconds (must be > startSec). */
    endSec: number;
    /** Job id for logging / namespacing temp outputs. */
    jobId: string;
}

export interface Clipper {
    /** Execute a clip operation returning path + progress stream. */
    clip(args: ClipArgs): Promise<ClipResult>;
}
````

## File: src/queue/asr.ts
````typescript
import { z } from 'zod';

export const AsrQueuePayloadSchema = z.object({
    asrJobId: z.string().uuid(),
    clipJobId: z.string().uuid().optional(),
    languageHint: z.string().optional(),
});

export type AsrQueuePayload = z.infer<typeof AsrQueuePayloadSchema>;
````

## File: src/queue/dlq-consumer.ts
````typescript
import PgBoss from 'pg-boss';
import {
    createLogger,
    type LogLevel,
    readEnv,
    readIntEnv,
    requireEnv,
} from '@clipper/common';

const envLevel = readEnv('LOG_LEVEL');
const level: LogLevel =
    envLevel === 'debug' ||
    envLevel === 'info' ||
    envLevel === 'warn' ||
    envLevel === 'error'
        ? envLevel
        : 'info';
const log = createLogger(level).with({ mod: 'queue-dlq' });

export async function startDlqConsumer(opts?: {
    connectionString?: string;
    schema?: string;
    queueName?: string;
    concurrency?: number;
}) {
    const connectionString =
        opts?.connectionString || requireEnv('DATABASE_URL');
    const schema = opts?.schema || readEnv('PG_BOSS_SCHEMA') || 'pgboss';
    const topic = (opts?.queueName ||
        readEnv('QUEUE_NAME') ||
        'clips') as string;
    const dlqTopic = `${topic}.dlq`;
    const concurrency = Number(
        opts?.concurrency || readIntEnv('QUEUE_CONCURRENCY', 2)
    );

    const boss = new PgBoss({ connectionString, schema });
    await boss.start();
    log.info('DLQ consumer started', { dlqTopic, concurrency });

    await boss.work(dlqTopic, { batchSize: concurrency }, async (jobs) => {
        for (const job of jobs) {
            const payload = job.data as Record<string, unknown>;
            log.error('DLQ message received', { jobId: job.id, payload });
            // TODO: integrate alerting (pager/email/webhook) here if desired
        }
    });

    return async () => {
        log.info('DLQ consumer stopping');
        await boss.stop();
    };
}
````

## File: src/queue/index.ts
````typescript
export * from './types';
export * from './pgboss';
export * from './dlq-consumer';
````

## File: src/queue/publish.ts
````typescript
import { PgBossQueueAdapter } from './pgboss';
import { requireEnv } from '@clipper/common';

async function main() {
    const jobId = process.argv[2] || process.env.JOB_ID;
    if (!jobId) {
        console.error('Usage: bun src/publish.ts <jobId> or JOB_ID=<id>');
        process.exit(1);
    }
    const queue = new PgBossQueueAdapter({
        connectionString: requireEnv('DATABASE_URL'),
    });
    await queue.publish({ jobId, priority: 'normal' });
    console.log('[publish] sent', { jobId });
    await queue.shutdown();
}

if (import.meta.main) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
````

## File: src/worker/asr.ts
````typescript
import {
    DrizzleAsrJobsRepo,
    DrizzleJobsRepo,
    DrizzleAsrArtifactsRepo,
    createDb,
    storageKeys,
    createSupabaseStorageRepo,
} from '@clipper/data';
import { buildArtifacts, GroqWhisperProvider } from '@clipper/asr';
import { QUEUE_TOPIC_ASR } from '@clipper/queue';
import {
    AsrQueuePayloadSchema,
    type AsrQueuePayload,
} from '@clipper/queue/asr';
import { createLogger, readEnv, fromException } from '@clipper/common';

export interface AsrWorkerDeps {
    asrJobs?: DrizzleAsrJobsRepo;
    clipJobs?: DrizzleJobsRepo;
    artifacts?: DrizzleAsrArtifactsRepo;
    provider?: GroqWhisperProvider;
    storage?: ReturnType<typeof createSupabaseStorageRepo>;
    queue: {
        consumeFrom: (
            topic: string,
            handler: (msg: any) => Promise<void>
        ) => Promise<void>;
    };
}

const log = createLogger((readEnv('LOG_LEVEL') as any) || 'info').with({
    mod: 'asrWorker',
});

export async function startAsrWorker(deps: AsrWorkerDeps) {
    const asrJobs = deps?.asrJobs ?? new DrizzleAsrJobsRepo(createDb());
    const clipJobs = deps?.clipJobs ?? new DrizzleJobsRepo(createDb());
    const artifacts =
        deps?.artifacts ?? new DrizzleAsrArtifactsRepo(createDb());
    const storage =
        deps?.storage ??
        (() => {
            try {
                return createSupabaseStorageRepo();
            } catch {
                return null as any;
            }
        })();
    const provider = deps?.provider ?? new GroqWhisperProvider();

    const timeoutMs = Number(readEnv('ASR_REQUEST_TIMEOUT_MS') || 120_000);
    const includeJson =
        (readEnv('ASR_JSON_SEGMENTS') || 'false').toLowerCase() === 'true';
    const mergeGapMs = Number(readEnv('MERGE_GAP_MS') || 150);

    await deps.queue.consumeFrom(QUEUE_TOPIC_ASR, async (msg: any) => {
        const parse = AsrQueuePayloadSchema.safeParse(msg as AsrQueuePayload);
        if (!parse.success) {
            log.warn('invalid asr payload', { issues: parse.error.issues });
            return; // drop invalid messages
        }
        const { asrJobId, clipJobId, languageHint } = parse.data;
        const startedAt = Date.now();
        let tmpLocal: string | null = null;
        try {
            // Load and claim job
            const job = await asrJobs.get(asrJobId);
            if (!job) {
                log.warn('asr job not found', { asrJobId });
                return;
            }
            if (job.status === 'done') return; // idempotent
            if (job.status === 'queued') {
                await asrJobs.patch(asrJobId, { status: 'processing' });
            }

            // Locate media: prefer clip resultVideoKey
            let inputLocal: string;
            if (clipJobId) {
                const clip = await clipJobs.get(clipJobId);
                if (!clip?.resultVideoKey) throw new Error('NO_CLIP_RESULT');
                if (!storage) throw new Error('STORAGE_NOT_AVAILABLE');
                inputLocal = await storage.download(clip.resultVideoKey);
                tmpLocal = inputLocal;
            } else {
                throw new Error('NO_INPUT_PROVIDED');
            }

            // Transcribe
            const res = await provider.transcribe(inputLocal, {
                timeoutMs,
                languageHint,
            });

            // Build artifacts
            const built = buildArtifacts(res.segments, {
                includeJson,
                mergeGapMs,
            });

            // Upload artifacts
            if (!storage) throw new Error('STORAGE_NOT_AVAILABLE');
            const owner = clipJobId ?? asrJobId;
            const srtKey = storageKeys.transcriptSrt(owner);
            const txtKey = storageKeys.transcriptText(owner);
            const jsonKey = includeJson
                ? storageKeys.transcriptJson(owner)
                : null;
            const srtPath = `/tmp/${owner}.srt`;
            const txtPath = `/tmp/${owner}.txt`;
            await Bun.write(srtPath, built.srt);
            await Bun.write(txtPath, built.text);
            await storage.upload(srtPath, srtKey, 'application/x-subrip');
            await storage.upload(txtPath, txtKey, 'text/plain; charset=utf-8');
            if (includeJson && jsonKey) {
                const jsonPath = `/tmp/${owner}.json`;
                await Bun.write(
                    jsonPath,
                    JSON.stringify(built.json || [], null, 0)
                );
                await storage.upload(jsonPath, jsonKey, 'application/json');
            }

            // Persist artifacts
            await artifacts.put({
                asrJobId,
                kind: 'srt',
                storageKey: srtKey,
                createdAt: new Date().toISOString(),
            });
            await artifacts.put({
                asrJobId,
                kind: 'text',
                storageKey: txtKey,
                createdAt: new Date().toISOString(),
            });
            if (includeJson && jsonKey)
                await artifacts.put({
                    asrJobId,
                    kind: 'json',
                    storageKey: jsonKey,
                    createdAt: new Date().toISOString(),
                });

            // Finalize job
            await asrJobs.patch(asrJobId, {
                status: 'done',
                detectedLanguage: res.detectedLanguage,
                durationSec: Math.round(res.durationSec),
                completedAt: new Date().toISOString(),
            });
        } catch (e) {
            const err = fromException(e, asrJobId);
            log.error('asr job failed', { asrJobId, err });
            try {
                await asrJobs.patch(asrJobId, {
                    status: 'failed',
                    errorCode:
                        (err.error && (err.error as any).code) || 'INTERNAL',
                    errorMessage:
                        (err.error && (err.error as any).message) || String(e),
                });
            } catch {}
            throw e; // let PgBoss retry
        } finally {
            try {
                if (tmpLocal) await Bun.spawn(['rm', '-f', tmpLocal]).exited;
            } catch {}
        }
    });
}
````

## File: .env.example
````
## Example .env for yt-clipper
# Copy to .env and fill in required values. Never commit real secrets.

SIGNED_URL_TTL_SEC=600
RETENTION_HOURS=72
MAX_CLIP_SECONDS=120
LOG_LEVEL=info
ADMIN_ENABLED=false

# --- Database / Supabase ---
# Fill these with your project values (do not commit secrets publicly)
# DATABASE_URL format (example): postgres://user:password@host:5432/db?sslmode=require
DATABASE_URL=postgresql://<user>:<password>@<host>:6543/postgres?sslmode=require
SUPABASE_URL=https://<your_project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your_supabase_service_role_key>
SUPABASE_SOURCES_BUCKET=sources
SUPABASE_RESULTS_BUCKET=results
SUPABASE_STORAGE_BUCKET=sources

# --- Queue (pg-boss) ---
QUEUE_PROVIDER=pgboss
PG_BOSS_SCHEMA=pgboss
QUEUE_NAME=clips
QUEUE_VISIBILITY_SEC=90
QUEUE_MAX_ATTEMPTS=3
QUEUE_RETRY_BACKOFF_MS_BASE=1000
QUEUE_RETRY_BACKOFF_MS_MAX=60000
QUEUE_CONCURRENCY=4
GROQ_API_KEY=
GROQ_MODEL=whisper-large-v3-turbo
NODE_ENV=development
DB_PASSWORD=

# --- Media IO / Resolver ---
# Local scratch directory for resolved sources (NVMe if available)
SCRATCH_DIR=/tmp/ytc
# Enable YouTube fetching via yt-dlp (false by default)
ENABLE_YTDLP=false
# Max input file size in megabytes (enforced by ffprobe / yt-dlp)
MAX_INPUT_MB=1024
# Max input duration in seconds (ffprobe validation)
MAX_CLIP_INPUT_DURATION_SEC=7200
# Optional comma-separated domain allowlist for external fetches
ALLOWLIST_HOSTS=

# Keep API clip limit for request validation (separate from input caps)
CLIP_MAX_DURATION_SEC=120
````

## File: .gitignore
````
# dependencies (bun install)
node_modules

# output
out
dist
*.tgz

# code coverage
coverage
*.lcov

# logs
logs
_.log
report.[0-9]_.[0-9]_.[0-9]_.[0-9]_.json

# dotenv environment variable files
.env
.env.development.local
.env.test.local
.env.production.local
.env.local

# caches
.eslintcache
.cache
*.tsbuildinfo

# IntelliJ based IDEs
.idea

# Finder (MacOS) folder config
.DS_Store
````

## File: bunfig.toml
````toml
# Resolve import aliases at runtime for Bun
# Matches tsconfig paths: "@clipper/*" -> "src/*"
[alias]
"@clipper/*" = "./src/*"
````

## File: CLAUDE.md
````markdown
---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";

// import .css files directly and it works
import './index.css';

import { createRoot } from "react-dom/client";

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.
````

## File: drizzle.config.ts
````typescript
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
    schema: './src/data/db/schema.ts',
    out: './src/data/drizzle',
    dialect: 'postgresql',
    dbCredentials: {
        url: process.env.DATABASE_URL!,
    },
    strict: true,
});
````

## File: index.ts
````typescript
console.log("Hello via Bun!");
````

## File: tsconfig.json
````json
{
  "compilerOptions": {
    // Environment setup & latest features
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "jsx": "react-jsx",
    "allowJs": true,

    // Bundler mode
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,

    // Path aliases
    "baseUrl": ".",
    "paths": {
      "@clipper/*": ["src/*"]
    },

    // Best practices
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,

    // Some stricter flags (disabled by default)
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noPropertyAccessFromIndexSignature": false
  }
}
````

## File: vitest.config.ts
````typescript
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
    resolve: {
        alias: {
            '@clipper/common': path.resolve(__dirname, 'src/common'),
            '@clipper/ffmpeg': path.resolve(__dirname, 'src/ffmpeg'),
            '@clipper/data': path.resolve(__dirname, 'src/data'),
            '@clipper/queue': path.resolve(__dirname, 'src/queue'),
            '@clipper/contracts': path.resolve(__dirname, 'src/contracts'),
        },
    },
    test: {
        include: ['src/**/*.test.ts', 'src/**/*.integration.test.ts'],
        testTimeout: 60000,
    },
});
````

## File: planning/tasks.md
````markdown
# Tasks

artifact_id: 8b32380f-56d6-4b78-a2e9-7a5aa72a3a61

This plan maps requirements to actionable work. All tasks are unchecked by default.

Legend: Requirements mapping uses section.item from requirements.md.

## 1. Stabilize common utilities and contracts

-   [ ] Fix env helpers (Req: 7, 9)
    -   [ ] Implement readEnv/requireEnv/readIntEnv in `src/common/env.ts` with proper fallback and parsing
    -   [ ] Add unit tests for integer parsing, missing keys
-   [ ] Complete error envelope and helpers (Req: 7)
    -   [ ] Finish `ServiceError`, `err`, and `fromException` in `src/common/errors.ts`
    -   [ ] Ensure redaction of details; add tests
-   [ ] Logger: implement createLogger and redact fields (Req: 7, 9)
    -   [ ] Complete `src/common/logger.ts` with JSON logging, base fields, and `.with()` child logger
    -   [ ] Add correlationId support via per-request context
-   [ ] Time utilities (Req: 1, 6)
    -   [ ] Finish `parseTimecode`, `formatTimecode`, `validateRange` in `src/common/time.ts`
    -   [ ] Add tests including edge cases and caps
-   [ ] State machine (Req: 2, 6)
    -   [ ] Implement `transition` in `src/common/state.ts` enforcing allowed map
    -   [ ] Add tests for valid/invalid transitions
-   [ ] Redaction utilities (Req: 7, 9)
    -   [ ] Implement `redactString`, `redactObject`, `redactSecrets` in `src/common/redact.ts`
    -   [ ] Unit tests covering API tokens, Authorization, query strings
-   [ ] Contracts (Req: 1,2,3,10)
    -   [ ] Complete `src/contracts/schemas.ts` for CreateJobInput, JobRecord
    -   [ ] Ensure enums for SourceType and JobStatus align; add tests
    -   [ ] Implement optional OpenAPI generation in `src/contracts/openapi.ts` and API route

## 2. Database schema and repos

-   [ ] Extend Drizzle schema (Req: 1,2,3,8,9)
    -   [ ] Add missing columns to `src/data/db/schema.ts`: source fields, timecodes, subtitle flags, result keys, status, timestamps
    -   [ ] Generate migration and update drizzle meta
-   [ ] Implement repository methods (Req: 1,2,3)
    -   [ ] Complete `src/data/db/repos.ts` with create/get/patch and events add/list
    -   [ ] Map to `src/data/repo.ts` interfaces; add tests
-   [ ] API keys (Req: 9)
    -   [ ] Finish `src/data/api-keys.ts` issue/revoke and token hash storage
    -   [ ] Add lookup/validate method; tests

## 3. Queue and worker

-   [ ] PgBoss adapter (Req: 1,3,7)
    -   [ ] Implement `start`, `shutdown`, `publish`, `subscribe` in `src/queue/pgboss.ts`
    -   [ ] Implement DLQ consumer in `src/queue/dlq-consumer.ts`
-   [ ] Worker loop (Req: 1,2,3,5,6)
    -   [ ] Complete `src/worker/index.ts` to subscribe and process messages
    -   [ ] Implement pipeline: resolve -> clip -> asr -> upload -> update status
    -   [ ] Idempotency: create temp working dir by jobId; check if results already exist
    -   [ ] Emit events and progress updates

## 4. Media IO and processing

-   [ ] Upload resolver (Req: 1,4,6)
    -   [ ] Implement `resolveUploadSource` in `src/data/media-io-upload.ts` including signed GET, streaming to scratch, ffprobe, limits
    -   [ ] Add return cleanup callback to remove scratch files
-   [ ] YouTube resolver (Req: 1,6,9)
    -   [ ] Implement `resolveYouTubeSource` in `src/data/media-io-youtube.ts` with ENABLE_YTDLP flag, ALLOWLIST_HOSTS, DNS safety
    -   [ ] Use yt-dlp and validate container/duration via ffprobe
-   [ ] ffmpeg clipping (Req: 6)
    -   [ ] Implement helper to attempt stream-copy and fallback to re-encode; expose metrics
    -   [ ] Validate duration tolerance and set result container
-   [ ] ASR via Groq (Req: 5)
    -   [x] Add minimal client for Groq Whisper; convert to SRT
    -   [ ] Burn-in using ffmpeg subtitles filter when requested

## 5. API surface

-   [ ] Elysia app (Req: 1,2,3,4,7,10)
    -   [ ] Implement POST /v1/jobs with zod validation and idempotency key support
    -   [ ] Implement GET /v1/jobs/:id and GET /v1/jobs/:id/results
    -   [ ] Implement POST /v1/uploads/sign for upload flow (Supabase)
    -   [ ] Add /health and /metrics endpoints
    -   [ ] Serve /openapi.json when ENABLE_OPENAPI=true
    -   [ ] Wire API key auth middleware; 401/403 handling

## 6. Storage repo and CLIs

-   [ ] Supabase storage repo (Req: 3,4)
    -   [ ] Implement signed upload/download, put, delete utilities
    -   [ ] Add content-type handling and TTL support
-   [ ] Bootstrap and cleanup scripts (Req: 8)
    -   [ ] Finish `src/data/scripts/bootstrap-storage.ts` to create buckets/prefixes
    -   [ ] Finish `src/data/cleanup.ts` and `src/data/scripts/cleanup.ts` for sweeper

## 7. Observability

-   [ ] Metrics (Req: 7)
    -   [ ] Verify `InMemoryMetrics` and add Prometheus exporter or integration
    -   [ ] Emit counters for queue lag, job durations, cleanup
-   [ ] Logging (Req: 7,9)
    -   [ ] Ensure all modules use createLogger with redaction; add correlationId propagation

## 8. Minimal UI (dogfood)

-   [ ] Create a simple static frontend (Req: 11)
    -   [ ] Page with form for creating jobs, list of jobs, polling, and download links
    -   [ ] Serve via Bun.serve or Elysia static route

## 9. Testing & quality gates

-   [ ] Unit tests for common utilities and contracts (Req: 1,2,6,7,9)
-   [ ] Integration tests for DB repos and queue (Req: 1,2,3)
-   [ ] E2E flow test using a tiny sample file (Req: 1-6)
-   [ ] Performance smoke to verify SLOs for 10s clip (Req: 6)
-   [ ] Lint/typecheck tasks in package.json; Bun test in CI

## 10. Docs & examples

-   [ ] README quickstart (Req: 10)
    -   [ ] Include env, run modes, sample curl requests
-   [ ] OpenAPI generation and examples (Req: 10)
    -   [ ] Ensure schemas map to OpenAPI; publish curl snippets

## 11. Deployment

-   [ ] Containerization and env (Req: NF)
    -   [ ] Provide Dockerfile and compose for API, worker, Postgres, pg-boss, and MinIO/Supabase (optional)
    -   [ ] Health and readiness probes

---

### Milestones

M1 — Stabilize core lib and contracts (sections 1, parts of 2)
M2 — Repos + API happy path (sections 2, 5)
M3 — Worker media pipeline (sections 3, 4)
M4 — Observability + cleanup (sections 6, 7)
M5 — Dogfood UI + docs + e2e (sections 8, 9, 10)

### Risks & mitigations

-   yt-dlp variability: pin version; cache; feature flag
-   ffmpeg accuracy: tolerance checks; fallback re-encode
-   ASR latency: async path and optional burn-in
-   Storage failures: retries with backoff; idempotent uploads
-   DNS safety gaps: deny private networks; strict allowlist
````

## File: src/asr/facade.ts
````typescript
import { createHash } from 'crypto';
import type {
    AsrArtifactsRepository,
    AsrArtifactRow,
    AsrJobsRepository,
} from '@clipper/data';
import type { QueueAdapter } from '@clipper/queue';
import { QUEUE_TOPIC_ASR } from '@clipper/queue';
import { AsrQueuePayloadSchema } from '@clipper/queue/asr';

export interface AsrFacadeDeps {
    asrJobs: AsrJobsRepository;
    asrArtifacts?: AsrArtifactsRepository;
    queue?: QueueAdapter; // optional for now; Task 5 will formalize ASR topic
}

export interface AsrRequest {
    localPath: string; // required: scratch media file to hash & transcribe
    clipJobId?: string;
    sourceType?: string; // upload | youtube | internal (default internal)
    sourceKey?: string; // optional storage key
    modelVersion?: string; // default from env or whisper-large-v3-turbo
    languageHint?: string; // 'auto' or ISO 639-1
}

export interface AsrRequestResult {
    asrJobId: string;
    status: 'reused' | 'queued';
    artifacts?: AsrArtifactRow[];
    mediaHash: string;
    modelVersion: string;
}

export class AsrFacade {
    constructor(private readonly deps: AsrFacadeDeps) {}

    async request(req: AsrRequest): Promise<AsrRequestResult> {
        const modelVersion =
            req.modelVersion ||
            process.env.GROQ_MODEL ||
            'whisper-large-v3-turbo';
        const mediaHash = await sha256File(req.localPath);

        // Try reuse shortcut
        const reusable = await this.deps.asrJobs.getReusable(
            mediaHash,
            modelVersion
        );
        if (reusable) {
            return {
                asrJobId: reusable.id,
                status: 'reused',
                artifacts: reusable.artifacts,
                mediaHash,
                modelVersion,
            };
        }

        // Create a new ASR job row (queued)
        const id = crypto.randomUUID();
        await this.deps.asrJobs.create({
            id,
            clipJobId: req.clipJobId,
            sourceType: req.sourceType || 'internal',
            sourceKey: req.sourceKey,
            mediaHash,
            modelVersion,
            languageHint: req.languageHint,
            status: 'queued',
        });

        // Fire-and-forget enqueue (Task 5 will add dedicated ASR queue/topic)
        if (this.deps.queue) {
            try {
                const payload = {
                    asrJobId: id,
                    clipJobId: req.clipJobId,
                    languageHint: req.languageHint,
                };
                const parsed = AsrQueuePayloadSchema.parse(payload);
                if (this.deps.queue.publishTo) {
                    await this.deps.queue.publishTo(QUEUE_TOPIC_ASR, parsed);
                } else {
                    // fallback: publish to default topic if multi-topic not supported
                    await this.deps.queue.publish({
                        jobId: id,
                        priority: 'normal',
                    });
                }
            } catch (e) {
                // Non-fatal here; job remains queued for a future publisher
            }
        }

        return { asrJobId: id, status: 'queued', mediaHash, modelVersion };
    }
}

async function sha256File(filePath: string): Promise<string> {
    const hasher = createHash('sha256');
    const file = Bun.file(filePath);
    const stream = file.stream();
    for await (const chunk of stream as any) {
        hasher.update(chunk);
    }
    return hasher.digest('hex');
}
````

## File: src/contracts/openapi.ts
````typescript
// Optional OpenAPI generator: only use when env flag ENABLE_OPENAPI === 'true'
// We avoid importing 'zod-to-openapi' types at compile time to keep it optional.
import { z } from 'zod';
import { readEnv } from '../common/env';

export async function maybeGenerateOpenApi(): Promise<any | null> {
    if (readEnv('ENABLE_OPENAPI') !== 'true') return null;
    const { OpenAPIGenerator, extendZodWithOpenApi } = (await import(
        'zod-to-openapi'
    )) as any;
    extendZodWithOpenApi(z as any);
    const S = await import('./schemas');
    const registry = new OpenAPIGenerator(
        {
            CreateJobInput: S.CreateJobInput,
            JobRecord: S.JobRecord,
        },
        '3.0.0'
    );
    return registry.generateDocument({
        openapi: '3.0.0',
        info: { title: 'Clipper API', version: '1.0.0' },
        paths: {},
    });
}
````

## File: src/data/db/connection.ts
````typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { readEnv } from '../../common/index';

export type DB = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(url = readEnv('DATABASE_URL')): DB {
    if (!url) {
        throw new Error('DATABASE_URL is required');
    }
    const pool = new Pool({ connectionString: url });
    return drizzle(pool, { schema });
}
````

## File: src/data/db/schema.ts
````typescript
import {
    pgEnum,
    pgTable,
    text,
    timestamp,
    uuid,
    integer,
    boolean,
    jsonb,
    index,
    primaryKey,
} from 'drizzle-orm/pg-core';

// Enums
export const jobStatus = pgEnum('job_status', [
    'queued',
    'processing',
    'done',
    'failed',
]);
export const sourceType = pgEnum('source_type', ['upload', 'youtube']);
export const asrJobStatus = pgEnum('asr_job_status', [
    'queued',
    'processing',
    'done',
    'failed',
]);

// jobs table
export const jobs = pgTable(
    'jobs',
    {
        id: uuid('id').primaryKey(),
        status: jobStatus('status').notNull().default('queued'),
        progress: integer('progress').notNull().default(0),
        sourceType: sourceType('source_type').notNull(),
        sourceKey: text('source_key'),
        sourceUrl: text('source_url'),
        startSec: integer('start_sec').notNull(),
        endSec: integer('end_sec').notNull(),
        withSubtitles: boolean('with_subtitles').notNull().default(false),
        burnSubtitles: boolean('burn_subtitles').notNull().default(false),
        subtitleLang: text('subtitle_lang'),
        resultVideoKey: text('result_video_key'),
        resultSrtKey: text('result_srt_key'),
        errorCode: text('error_code'),
        errorMessage: text('error_message'),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        expiresAt: timestamp('expires_at', { withTimezone: true }),
    },
    (t) => [
        index('idx_jobs_status_created_at').on(t.status, t.createdAt),
        index('idx_jobs_expires_at').on(t.expiresAt),
    ]
);

// job_events table
export const jobEvents = pgTable(
    'job_events',
    {
        jobId: uuid('job_id')
            .notNull()
            .references(() => jobs.id, { onDelete: 'cascade' }),
        ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
        type: text('type').notNull(),
        data: jsonb('data'),
    },
    (t) => [index('idx_job_events_job_id_ts').on(t.jobId, t.ts)]
);

// api_keys table (optional)
export const apiKeys = pgTable('api_keys', {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(),
    revoked: boolean('revoked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

// ASR tables
export const asrJobs = pgTable(
    'asr_jobs',
    {
        id: uuid('id').primaryKey(),
        clipJobId: uuid('clip_job_id').references(() => jobs.id),
        sourceType: text('source_type').notNull(), // upload | youtube | internal
        sourceKey: text('source_key'),
        mediaHash: text('media_hash').notNull(),
        modelVersion: text('model_version').notNull(),
        languageHint: text('language_hint'),
        detectedLanguage: text('detected_language'),
        durationSec: integer('duration_sec'),
        status: asrJobStatus('status').notNull().default('queued'),
        errorCode: text('error_code'),
        errorMessage: text('error_message'),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        completedAt: timestamp('completed_at', { withTimezone: true }),
        expiresAt: timestamp('expires_at', { withTimezone: true }),
    },
    (t) => [
        index('idx_asr_jobs_status_created_at').on(t.status, t.createdAt),
        index('idx_asr_jobs_expires_at').on(t.expiresAt),
        // Unique partial index handled via raw SQL migration (media_hash, model_version) where status='done'
    ]
);

export const asrArtifacts = pgTable(
    'asr_artifacts',
    {
        asrJobId: uuid('asr_job_id')
            .notNull()
            .references(() => asrJobs.id, { onDelete: 'cascade' }),
        kind: text('kind').notNull(), // srt | text | json
        storageKey: text('storage_key').notNull(),
        sizeBytes: integer('size_bytes'),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
    },
    (t) => [primaryKey({ columns: [t.asrJobId, t.kind] })]
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobEvent = typeof jobEvents.$inferSelect;
export type NewJobEvent = typeof jobEvents.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type AsrJob = typeof asrJobs.$inferSelect;
export type NewAsrJob = typeof asrJobs.$inferInsert;
export type AsrArtifact = typeof asrArtifacts.$inferSelect;
export type NewAsrArtifact = typeof asrArtifacts.$inferInsert;
````

## File: src/data/drizzle/meta/_journal.json
````json
{
    "version": "7",
    "dialect": "postgresql",
    "entries": [
        {
            "idx": 0,
            "version": "7",
            "when": 1754887720633,
            "tag": "0000_tense_yellow_claw",
            "breakpoints": true
        },
        {
            "idx": 1,
            "version": "7",
            "when": 1754966400000,
            "tag": "0001_asr_jobs",
            "breakpoints": true
        }
    ]
}
````

## File: src/data/cleanup.ts
````typescript
import { createDb } from './db/connection';
import { jobs } from './db/schema';
import { lte, isNotNull, and, eq, desc } from 'drizzle-orm';
import type { StorageRepo } from './storage';
import type { Logger } from '../common';
import { createLogger, noopMetrics, type Metrics } from '../common';

export type CleanupOptions = {
    now?: Date;
    batchSize?: number;
    dryRun?: boolean;
    rateLimitDelayMs?: number;
    storage?: StorageRepo | null;
    logger?: Logger;
    metrics?: Metrics;
};

export type CleanupItem = {
    jobId: string;
    resultKeys: string[];
};

export type CleanupResult = {
    scanned: number;
    deletedJobs: number;
    deletedObjects: number;
    items: CleanupItem[];
    errors: Array<{ jobId: string; stage: 'storage' | 'db'; error: string }>;
};

export async function cleanupExpiredJobs(
    opts: CleanupOptions = {}
): Promise<CleanupResult> {
    const db = createDb();
    const now = opts.now ?? new Date();
    const limit = opts.batchSize ?? 100;
    const dryRun = opts.dryRun ?? true;
    const delay = opts.rateLimitDelayMs ?? 0;
    const storage = opts.storage ?? null;
    const logger =
        opts.logger ?? createLogger('info').with({ comp: 'cleanup' });
    const metrics = opts.metrics ?? noopMetrics;

    const rows = await db
        .select()
        .from(jobs)
        .where(and(isNotNull(jobs.expiresAt), lte(jobs.expiresAt, now)))
        .orderBy(desc(jobs.expiresAt))
        .limit(limit);

    const result: CleanupResult = {
        scanned: rows.length,
        deletedJobs: 0,
        deletedObjects: 0,
        items: [],
        errors: [],
    };

    for (const r of rows) {
        const jobId = r.id as string;
        const keys = [r.resultVideoKey, r.resultSrtKey].filter(
            (k): k is string => !!k
        );
        result.items.push({ jobId, resultKeys: keys });

        if (dryRun) continue;

        // remove storage objects if configured
        if (storage) {
            for (const key of keys) {
                try {
                    await storage.remove(key);
                    result.deletedObjects++;
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    result.errors.push({ jobId, stage: 'storage', error: msg });
                    logger?.warn('storage delete failed', { jobId, key, msg });
                }
                if (delay > 0) await sleep(delay);
            }
        }

        // delete the job (cascades events)
        try {
            await db.delete(jobs).where(eq(jobs.id, jobId));
            result.deletedJobs++;
            metrics.inc('cleanup.jobs.deleted', 1);
            logger.info('job deleted', { jobId });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            result.errors.push({ jobId, stage: 'db', error: msg });
            logger?.error('db delete failed', { jobId, msg });
        }

        if (delay > 0) await sleep(delay);
    }

    return result;
}

function sleep(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
}
````

## File: src/data/media-io-upload.ts
````typescript
import { createSupabaseStorageRepo } from './storage';
import {
    readEnv,
    readIntEnv,
    createLogger,
    noopMetrics,
    type Metrics,
} from '../common';
import type { ResolveResult as SharedResolveResult } from './media-io';

type ResolveJob = {
    id: string;
    sourceType: 'upload';
    sourceKey: string; // required for upload path
};

export type FfprobeMeta = {
    durationSec: number;
    sizeBytes: number;
    container?: string;
};

export type UploadResolveResult = SharedResolveResult;

async function streamToFile(
    url: string,
    outPath: string,
    metrics: Metrics,
    labels: Record<string, string>
) {
    const res = await fetch(url);
    if (!res.ok || !res.body) {
        throw new Error(`DOWNLOAD_FAILED: status=${res.status}`);
    }
    const counting = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            metrics.inc('mediaio.download.bytes', chunk.byteLength, labels);
            controller.enqueue(chunk);
        },
    });
    const stream = res.body.pipeThrough(counting);
    await Bun.write(outPath, new Response(stream));
}

async function ffprobe(localPath: string): Promise<FfprobeMeta> {
    const args = [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        localPath,
    ];
    const proc = Bun.spawn(['ffprobe', ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    if (exit !== 0) throw new Error('FFPROBE_FAILED');
    const json = JSON.parse(stdout);
    const durationSec = json?.format?.duration
        ? Number(json.format.duration)
        : 0;
    const sizeBytes = json?.format?.size
        ? Number(json.format.size)
        : Bun.file(localPath).size;
    const container = json?.format?.format_name as string | undefined;
    return { durationSec, sizeBytes, container };
}

export async function resolveUploadSource(
    job: ResolveJob,
    deps: { metrics?: Metrics } = {}
): Promise<UploadResolveResult> {
    const logger = createLogger((readEnv('LOG_LEVEL') as any) ?? 'info').with({
        comp: 'mediaio',
        jobId: job.id,
    });
    const metrics = deps.metrics ?? noopMetrics;

    const SCRATCH_DIR = readEnv('SCRATCH_DIR') ?? '/tmp/ytc';
    const MAX_MB = readIntEnv('MAX_INPUT_MB', 1024)!;
    const MAX_DUR = readIntEnv('MAX_CLIP_INPUT_DURATION_SEC', 7200)!;

    const m = job.sourceKey.match(/\.([A-Za-z0-9]+)$/);
    const ext = m ? `.${m[1]}` : '.mp4';
    const baseDir = `${SCRATCH_DIR.replace(/\/$/, '')}/sources/${job.id}`;
    const localPath = `${baseDir}/source${ext}`;

    logger.info('resolving upload to local path');
    {
        const p = Bun.spawn(['mkdir', '-p', baseDir]);
        const code = await p.exited;
        if (code !== 0) throw new Error('MKDIR_FAILED');
    }

    // Sign and stream download
    const storage = createSupabaseStorageRepo();
    const signedUrl = await storage.sign(job.sourceKey);
    await streamToFile(signedUrl, localPath, metrics, { jobId: job.id });

    // ffprobe validation
    const meta = await ffprobe(localPath);

    if (meta.durationSec > MAX_DUR || meta.sizeBytes > MAX_MB * 1024 * 1024) {
        // cleanup on violation
        const p = Bun.spawn(['rm', '-rf', baseDir]);
        await p.exited;
        throw new Error('INPUT_TOO_LARGE');
    }

    const cleanup = async () => {
        const p = Bun.spawn(['rm', '-rf', baseDir]);
        await p.exited;
    };

    logger.info('upload resolved', {
        durationSec: meta.durationSec,
        sizeBytes: meta.sizeBytes,
    });
    return { localPath, cleanup, meta };
}
````

## File: src/data/media-io-youtube.ts
````typescript
import {
    readEnv,
    readIntEnv,
    createLogger,
    noopMetrics,
    type Metrics,
} from '../common/index';
import type { ResolveResult as SharedResolveResult } from './media-io';
import { readdir } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';

type ResolveJob = {
    id: string;
    sourceType: 'youtube';
    sourceUrl: string; // required for youtube path
};

export type FfprobeMeta = {
    durationSec: number;
    sizeBytes: number;
    container?: string;
};

export type YouTubeResolveResult = SharedResolveResult;

function isPrivateIPv4(ip: string): boolean {
    if (!/^[0-9.]+$/.test(ip)) return false;
    const parts = ip.split('.').map((x) => Number(x));
    if (parts.length !== 4) return false;
    const a = parts[0]!;
    const b = parts[1]!;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 0) return true; // 0.0.0.0/8
    return false;
}

function isPrivateIPv6(ip: string): boolean {
    // very coarse checks
    const v = ip.toLowerCase();
    if (v === '::1') return true; // loopback
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // ULA fc00::/7
    if (v.startsWith('fe80:')) return true; // link-local fe80::/10
    if (v === '::' || v === '::0') return true; // unspecified
    return false;
}

async function assertSafeUrl(rawUrl: string) {
    let u: URL;
    try {
        u = new URL(rawUrl);
    } catch {
        throw new Error('SSRF_BLOCKED');
    }
    if (!/^https?:$/.test(u.protocol)) throw new Error('SSRF_BLOCKED');
    const allowlist = (readEnv('ALLOWLIST_HOSTS') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (allowlist.length > 0 && !allowlist.includes(u.hostname)) {
        throw new Error('SSRF_BLOCKED');
    }
    // Resolve host to IPs and block private/link-local
    try {
        const res = await lookup(u.hostname, { all: true });
        for (const { address, family } of res) {
            if (
                (family === 4 && isPrivateIPv4(address)) ||
                (family === 6 && isPrivateIPv6(address))
            )
                throw new Error('SSRF_BLOCKED');
        }
    } catch (e) {
        // If DNS fails, treat as blocked to be safe
        throw new Error('SSRF_BLOCKED');
    }
}

async function ffprobe(localPath: string): Promise<FfprobeMeta> {
    const args = [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        localPath,
    ];
    const proc = Bun.spawn(['ffprobe', ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    if (exit !== 0) throw new Error('FFPROBE_FAILED');
    const json = JSON.parse(stdout);
    const durationSec = json?.format?.duration
        ? Number(json.format.duration)
        : 0;
    const sizeBytes = json?.format?.size
        ? Number(json.format.size)
        : Bun.file(localPath).size;
    const container = json?.format?.format_name as string | undefined;
    return { durationSec, sizeBytes, container };
}

async function findDownloadedFile(baseDir: string): Promise<string | null> {
    const files = await readdir(baseDir).catch(() => []);
    const candidates = files.filter((f) => f.startsWith('source.'));
    if (candidates.length === 0) return null;
    // Prefer mp4 if present
    const mp4 = candidates.find((f) => f.endsWith('.mp4'));
    const chosen = mp4 ?? candidates[0];
    return `${baseDir}/${chosen}`;
}

export async function resolveYouTubeSource(
    job: ResolveJob,
    deps: { metrics?: Metrics } = {}
): Promise<YouTubeResolveResult> {
    const logger = createLogger((readEnv('LOG_LEVEL') as any) ?? 'info').with({
        comp: 'mediaio',
        jobId: job.id,
    });
    const metrics = deps.metrics ?? noopMetrics;

    const SCRATCH_DIR = readEnv('SCRATCH_DIR') ?? '/tmp/ytc';
    const MAX_MB = readIntEnv('MAX_INPUT_MB', 1024)!;
    const MAX_DUR = readIntEnv('MAX_CLIP_INPUT_DURATION_SEC', 7200)!;
    const ENABLE = (readEnv('ENABLE_YTDLP') ?? 'false') === 'true';

    const baseDir = `${SCRATCH_DIR.replace(/\/$/, '')}/sources/${job.id}`;
    const outTemplate = `${baseDir}/source.%(ext)s`;

    const resolveStart = Date.now();
    logger.info('resolving youtube to local path');

    if (!ENABLE) {
        logger.warn('yt-dlp disabled, rejecting request');
        throw new Error('YTDLP_DISABLED');
    }

    await assertSafeUrl(job.sourceUrl);

    {
        const p = Bun.spawn(['mkdir', '-p', baseDir]);
        const code = await p.exited;
        if (code !== 0) throw new Error('MKDIR_FAILED');
    }

    // Run yt-dlp
    const ytdlpArgs = [
        '-f',
        'bv*+ba/b',
        '-o',
        outTemplate,
        '--quiet',
        '--no-progress',
        '--no-cache-dir',
        '--no-part',
        '--retries',
        '3',
    ];
    if (MAX_MB && MAX_MB > 0) {
        ytdlpArgs.push('--max-filesize', `${MAX_MB}m`);
    }
    ytdlpArgs.push(job.sourceUrl);

    const ytdlpStart = Date.now();
    const proc = Bun.spawn(['yt-dlp', ...ytdlpArgs], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {}, // minimal env to avoid secret leaks
    });
    const timeoutMs = Math.min(MAX_DUR * 1000, 15 * 60 * 1000); // cap timeout to 15min
    let timedOut = false;
    const timeout = setTimeout(() => {
        try {
            proc.kill('SIGKILL');
            timedOut = true;
        } catch {}
    }, timeoutMs);

    const exitCode = await proc.exited;
    clearTimeout(timeout);
    metrics.observe('mediaio.ytdlp.duration_ms', Date.now() - ytdlpStart, {
        jobId: job.id,
    });

    if (timedOut) {
        // cleanup and throw
        const p = Bun.spawn(['rm', '-rf', baseDir]);
        await p.exited;
        throw new Error('YTDLP_TIMEOUT');
    }
    if (exitCode !== 0) {
        const p = Bun.spawn(['rm', '-rf', baseDir]);
        await p.exited;
        throw new Error('YTDLP_FAILED');
    }

    const localPath = await findDownloadedFile(baseDir);
    if (!localPath) {
        const p = Bun.spawn(['rm', '-rf', baseDir]);
        await p.exited;
        throw new Error('YTDLP_FAILED');
    }

    // ffprobe validation
    const ffStart = Date.now();
    const meta = await ffprobe(localPath);
    metrics.observe('mediaio.ffprobe.duration_ms', Date.now() - ffStart, {
        jobId: job.id,
    });

    if (meta.durationSec > MAX_DUR || meta.sizeBytes > MAX_MB * 1024 * 1024) {
        const p = Bun.spawn(['rm', '-rf', baseDir]);
        await p.exited;
        throw new Error('INPUT_TOO_LARGE');
    }

    const cleanup = async () => {
        const p = Bun.spawn(['rm', '-rf', baseDir]);
        await p.exited;
    };

    const totalMs = Date.now() - resolveStart;
    metrics.observe('mediaio.resolve.duration_ms', totalMs, {
        jobId: job.id,
    });
    logger.info('youtube resolved', {
        durationSec: meta.durationSec,
        sizeBytes: meta.sizeBytes,
        durationMs: totalMs,
    });

    return { localPath, cleanup, meta };
}
````

## File: src/data/repo.ts
````typescript
import type { JobStatus } from '@clipper/contracts';

export interface JobRow {
    id: string;
    status: JobStatus;
    progress: number;
    sourceType: 'upload' | 'youtube';
    sourceKey?: string;
    sourceUrl?: string;
    startSec: number;
    endSec: number;
    withSubtitles: boolean;
    burnSubtitles: boolean;
    subtitleLang?: string;
    resultVideoKey?: string;
    resultSrtKey?: string;
    errorCode?: string;
    errorMessage?: string;
    createdAt: string;
    updatedAt: string;
    expiresAt?: string;
}

export interface JobEvent {
    jobId: string;
    ts: string;
    type: string;
    data?: Record<string, unknown>;
}

export interface JobsRepository {
    create(row: Omit<JobRow, 'createdAt' | 'updatedAt'>): Promise<JobRow>;
    get(id: string): Promise<JobRow | null>;
    update(id: string, patch: Partial<JobRow>): Promise<JobRow>;
    listByStatus(
        status: JobStatus,
        limit?: number,
        offset?: number
    ): Promise<JobRow[]>;
    transition(
        id: string,
        next: JobStatus,
        event?: { type?: string; data?: Record<string, unknown> }
    ): Promise<JobRow>;
}

export interface JobEventsRepository {
    add(evt: JobEvent): Promise<void>;
    list(jobId: string, limit?: number, offset?: number): Promise<JobEvent[]>;
}

// --- ASR (Automatic Speech Recognition) domain types ---
export type AsrJobStatus = 'queued' | 'processing' | 'done' | 'failed';

export interface AsrJobRow {
    id: string;
    clipJobId?: string;
    sourceType: string; // upload | youtube | internal
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

export interface AsrArtifactRow {
    asrJobId: string;
    kind: 'srt' | 'text' | 'json';
    storageKey: string;
    sizeBytes?: number;
    createdAt: string;
}

export interface AsrJobsRepository {
    create(
        row: Omit<AsrJobRow, 'createdAt' | 'updatedAt' | 'status'> &
            Partial<Pick<AsrJobRow, 'status'>>
    ): Promise<AsrJobRow>;
    get(id: string): Promise<AsrJobRow | null>;
    getReusable(
        mediaHash: string,
        modelVersion: string
    ): Promise<(AsrJobRow & { artifacts: AsrArtifactRow[] }) | null>;
    patch(id: string, patch: Partial<AsrJobRow>): Promise<AsrJobRow>;
}

export interface AsrArtifactsRepository {
    put(artifact: AsrArtifactRow): Promise<void>;
    list(asrJobId: string): Promise<AsrArtifactRow[]>;
}

// Minimal in-memory impl to wire API/worker until DB is added
export class InMemoryJobsRepo implements JobsRepository {
    private map = new Map<string, JobRow>();
    async create(
        row: Omit<JobRow, 'createdAt' | 'updatedAt'>
    ): Promise<JobRow> {
        const now = new Date().toISOString();
        const rec: JobRow = { ...row, createdAt: now, updatedAt: now };
        this.map.set(rec.id, rec);
        return rec;
    }
    async get(id: string) {
        return this.map.get(id) ?? null;
    }
    async update(id: string, patch: Partial<JobRow>): Promise<JobRow> {
        const cur = this.map.get(id);
        if (!cur) throw new Error('NOT_FOUND');
        const next = {
            ...cur,
            ...patch,
            updatedAt: new Date().toISOString(),
        } as JobRow;
        this.map.set(id, next);
        return next;
    }
    async listByStatus(
        status: JobStatus,
        limit = 50,
        offset = 0
    ): Promise<JobRow[]> {
        return Array.from(this.map.values())
            .filter((r) => r.status === status)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .slice(offset, offset + limit);
    }
    async transition(
        id: string,
        next: JobStatus,
        event?: { type?: string; data?: Record<string, unknown> }
    ): Promise<JobRow> {
        const cur = await this.get(id);
        if (!cur) throw new Error('NOT_FOUND');
        const updated = await this.update(id, { status: next });
        // no-op event store here; handled by InMemoryJobEventsRepo
        return updated;
    }
}

export class InMemoryJobEventsRepo implements JobEventsRepository {
    private events: JobEvent[] = [];
    async add(evt: JobEvent): Promise<void> {
        this.events.push(evt);
    }
    async list(jobId: string, limit = 100, offset = 0): Promise<JobEvent[]> {
        return this.events
            .filter((e) => e.jobId === jobId)
            .sort((a, b) => a.ts.localeCompare(b.ts))
            .slice(offset, offset + limit);
    }
}
````

## File: src/ffmpeg/clipper.ts
````typescript
/**
 * BunClipper: performs a two-phase FFmpeg clipping strategy
 * 1) Fast path: stream copy (-c copy)
 * 2) Fallback: re-encode (libx264 + aac)
 * Exposes an AsyncIterable progress$ (0..100) for the successful attempt.
 */
import type { ClipArgs, ClipResult, Clipper } from './types';
import { parseFfmpegProgress } from './progress';
import { createLogger, readEnv } from '@clipper/common';
import { mkdir } from 'node:fs/promises';
import { ServiceError } from '@clipper/common/errors';

const log = createLogger((readEnv('LOG_LEVEL') as any) || 'info').with({
    mod: 'ffmpeg',
});

// Format seconds into HH:MM:SS.mmm (zero padded)
function fmtTs(sec: number): string {
    const sign = sec < 0 ? '-' : '';
    const s = Math.abs(sec);
    const hh = Math.floor(s / 3600)
        .toString()
        .padStart(2, '0');
    const mm = Math.floor((s % 3600) / 60)
        .toString()
        .padStart(2, '0');
    const ss = Math.floor(s % 60)
        .toString()
        .padStart(2, '0');
    const ms = Math.round((s - Math.floor(s)) * 1000)
        .toString()
        .padStart(3, '0');
    return `${sign}${hh}:${mm}:${ss}.${ms}`;
}

interface AttemptResult {
    ok: boolean;
    code: number;
    stderrSnippet?: string;
}

/**
 * BunClipper implements the Clipper interface using a two-phase strategy:
 * 1. Attempt a fast stream copy (no re-encode) for speed when keyframes align.
 * 2. On failure, fallback to a re-encode ensuring playable, accurate output.
 *
 * Progress semantics:
 * - Each attempt produces its own progress stream.
 * - For a successful copy attempt, the progress stream usually completes quickly.
 * - If fallback is required, only the fallback attempt's progress is exposed.
 */
export class BunClipper implements Clipper {
    constructor(private readonly opts: { scratchDir?: string } = {}) {}

    async clip(args: ClipArgs): Promise<ClipResult> {
        // Input validation
        if (args.startSec < 0 || args.endSec < 0) {
            throw new ServiceError(
                'VALIDATION_FAILED',
                'start/end must be >= 0'
            );
        }
        if (args.endSec <= args.startSec) {
            throw new ServiceError(
                'VALIDATION_FAILED',
                'endSec must be > startSec'
            );
        }
        const srcFile = Bun.file(args.input);
        // Bun.file(...).size will throw if not exists; so optionally check via try/catch
        let fileExists = false;
        try {
            // @ts-ignore size triggers stat
            await srcFile.arrayBuffer(); // minimal read (will allocate). If large file this is heavy; prefer stat when Bun exposes. For now just check existence via stream open.
            fileExists = true;
        } catch {
            fileExists = false;
        }
        if (!fileExists) {
            throw new ServiceError(
                'VALIDATION_FAILED',
                'input file does not exist'
            );
        }

        const scratchBase =
            this.opts.scratchDir || readEnv('SCRATCH_DIR') || '/tmp/ytc';
        const outDir = `${scratchBase}/${args.jobId}`;
        const outPath = `${outDir}/clip.mp4`;
        await mkdir(outDir, { recursive: true });

        const totalDuration = args.endSec - args.startSec;
        const startTs = fmtTs(args.startSec);
        // ffmpeg -ss <start> -i input -to <end> where -ss before -i is fast seek; -to uses absolute timeline
        const endTs = fmtTs(args.endSec);

        const attempt = async (
            mode: 'copy' | 'reencode'
        ): Promise<{
            attempt: AttemptResult;
            progress$?: AsyncIterable<number>;
        }> => {
            const common = [
                '-hide_banner',
                '-y',
                '-progress',
                'pipe:1',
                '-ss',
                startTs,
                '-i',
                args.input,
                '-to',
                endTs,
                '-movflags',
                '+faststart',
            ];
            const modeArgs =
                mode === 'copy'
                    ? ['-c', 'copy']
                    : [
                          '-c:v',
                          'libx264',
                          '-preset',
                          'veryfast',
                          '-c:a',
                          'aac',
                          '-profile:v',
                          'high',
                          '-pix_fmt',
                          'yuv420p',
                      ];
            const full = ['ffmpeg', ...common, ...modeArgs, outPath];
            const started = performance.now();
            log.debug('ffmpeg attempt start', {
                jobId: args.jobId,
                mode,
                full,
            });
            const proc = Bun.spawn(full, { stdout: 'pipe', stderr: 'pipe' });
            const stderrChunks: Uint8Array[] = [];
            const maxErrBytes = 4096;
            (async () => {
                if (!proc.stderr) return;
                for await (const chunk of proc.stderr) {
                    if (
                        stderrChunks.reduce((a, c) => a + c.byteLength, 0) <
                        maxErrBytes
                    ) {
                        stderrChunks.push(chunk);
                    }
                }
            })();
            const progress$ = proc.stdout
                ? parseFfmpegProgress(proc.stdout, totalDuration)
                : (async function* () {
                      yield 100;
                  })();
            const exitCode = await proc.exited;
            const durMs = Math.round(performance.now() - started);
            const attemptRes: AttemptResult = {
                ok: exitCode === 0,
                code: exitCode,
                stderrSnippet: !stderrChunks.length
                    ? undefined
                    : new TextDecoder().decode(
                          stderrChunks.reduce(
                              (acc, c) =>
                                  new Uint8Array([
                                      ...acc,
                                      ...new Uint8Array(c),
                                  ]),
                              new Uint8Array()
                          )
                      ),
            };
            log.debug('ffmpeg attempt done', {
                jobId: args.jobId,
                mode,
                code: exitCode,
                ms: durMs,
            });
            return { attempt: attemptRes, progress$ };
        };

        // Fast path attempt
        const copyResult = await attempt('copy');
        if (copyResult.attempt.ok) {
            // Provide progress$ from copy attempt (already consumed until exit). For copy success, progress$ has already completed.
            return { localPath: outPath, progress$: copyResult.progress$! };
        }

        // Fallback (fresh progress stream)
        log.info('stream copy failed; falling back to re-encode', {
            jobId: args.jobId,
            code: copyResult.attempt.code,
        });
        const reResult = await attempt('reencode');
        if (reResult.attempt.ok) {
            return { localPath: outPath, progress$: reResult.progress$! };
        }
        // Both failed
        const msg = `ffmpeg failed (copy code=${copyResult.attempt.code}, reencode code=${reResult.attempt.code})`;
        throw new ServiceError('BAD_REQUEST', msg); // using existing code enum; adjust if more codes added later
    }
}
````

## File: src/ffmpeg/progress.ts
````typescript
/**
 * Consumes an ffmpeg `-progress pipe:1` output stream and yields integer percentage progress values.
 *
 * Contract:
 * - Input: raw ReadableStream<Uint8Array> from ffmpeg stdout configured with `-progress pipe:1`.
 * - Emits: monotonically increasing integers 0..100 (holding at 99 until process exit) then a final 100.
 * - Zero / invalid total duration → emits 100 immediately.
 *
 * Parsing focuses on `out_time_ms` lines; other lines are ignored.
 */
export async function* parseFfmpegProgress(
    stream: ReadableStream<Uint8Array>,
    totalDurationSec: number
): AsyncIterable<number> {
    if (totalDurationSec <= 0 || !Number.isFinite(totalDurationSec)) {
        // Degenerate case: emit 100 immediately
        yield 100;
        return;
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let lastPercent = -1;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
            // Format: out_time_ms=1234567
            if (line.startsWith('out_time_ms=')) {
                const msStr = line.substring('out_time_ms='.length).trim();
                const ms = Number.parseInt(msStr, 10);
                if (!Number.isNaN(ms)) {
                    const sec = ms / 1_000_000;
                    let pct = Math.floor((sec / totalDurationSec) * 100);
                    if (pct >= 100) pct = 99; // hold 100 until process exit
                    if (pct > lastPercent) {
                        lastPercent = pct;
                        yield pct;
                    }
                }
            }
        }
    }
    try {
        reader.releaseLock();
    } catch {}
    if (lastPercent < 100) yield 100;
}
````

## File: src/queue/pgboss.ts
````typescript
import PgBoss from 'pg-boss';
import { readEnv, readIntEnv } from '@clipper/common';
import type { QueueAdapter, QueueMessage, QueuePriority } from './types';
import { QUEUE_TOPIC_CLIPS } from './types';

const priorityMap: Record<QueuePriority, number> = {
    fast: 10,
    normal: 50,
    bulk: 90,
};

export class PgBossQueueAdapter implements QueueAdapter {
    private boss?: PgBoss;
    private topic: string;
    private dlqTopic: string;
    private metrics = {
        publishes: 0,
        claims: 0,
        completes: 0,
        retries: 0,
        errors: 0,
        dlq: 0,
    };

    constructor(
        private readonly opts: {
            connectionString: string;
            schema?: string;
            queueName?: string;
            concurrency?: number;
            visibilityTimeoutSec?: number;
            maxAttempts?: number;
        }
    ) {
        this.topic =
            opts.queueName ?? readEnv('QUEUE_NAME') ?? QUEUE_TOPIC_CLIPS;
        this.dlqTopic = `${this.topic}.dlq`;
    }

    async start() {
        if (this.boss) return;
        this.boss = new PgBoss({
            connectionString: this.opts.connectionString,
            schema: this.opts.schema ?? readEnv('PG_BOSS_SCHEMA') ?? 'pgboss',
        });
        this.boss.on('error', (err) => {
            // Increment error metric on boss-level errors
            this.metrics.errors++;
            // Avoid importing logger to keep package lean; rely on caller logs
            console.error('[pgboss] error', err);
        });
        await this.boss.start();
        // Ensure queues exist with basic policies
        const expireInSeconds = Math.max(
            1,
            Math.floor(
                Number(
                    readIntEnv(
                        'QUEUE_VISIBILITY_SEC',
                        this.opts.visibilityTimeoutSec ?? 90
                    )
                )
            )
        );
        const retryLimit = Number(
            readIntEnv('QUEUE_MAX_ATTEMPTS', this.opts.maxAttempts ?? 3)
        );
        try {
            await this.boss.createQueue(this.topic, {
                name: this.topic,
                expireInSeconds,
                retryLimit,
                deadLetter: this.dlqTopic,
            });
        } catch (err) {
            // Intentionally ignore errors if the queue already exists
            // console.error('Error creating queue:', err);
        }
        try {
            await this.boss.createQueue(this.dlqTopic, {
                name: this.dlqTopic,
                expireInSeconds: expireInSeconds * 2,
                retryLimit: 0,
            });
        } catch {}
    }

    async publish(
        msg: QueueMessage,
        opts?: { timeoutSec?: number }
    ): Promise<void> {
        if (!this.boss) await this.start();
        const expireInSeconds = Math.max(
            1,
            Math.floor(
                opts?.timeoutSec ??
                    Number(
                        readIntEnv(
                            'QUEUE_VISIBILITY_SEC',
                            this.opts.visibilityTimeoutSec ?? 90
                        )
                    )
            )
        );
        const attemptLimit = Number(
            readIntEnv('QUEUE_MAX_ATTEMPTS', this.opts.maxAttempts ?? 3)
        );
        const priority = priorityMap[msg.priority ?? 'normal'];
        await this.boss!.send(this.topic, msg as object, {
            priority,
            expireInSeconds,
            retryLimit: attemptLimit,
            retryBackoff: true,
            deadLetter: this.dlqTopic,
        });
        this.metrics.publishes++;
    }

    async consume(
        handler: (msg: QueueMessage) => Promise<void>
    ): Promise<void> {
        if (!this.boss) await this.start();
        const batchSize = Number(
            readIntEnv('QUEUE_CONCURRENCY', this.opts.concurrency ?? 4)
        );
        await this.boss!.work<QueueMessage>(
            this.topic,
            { batchSize },
            async (jobs) => {
                for (const job of jobs) {
                    this.metrics.claims++;
                    try {
                        await handler(job.data as QueueMessage);
                        this.metrics.completes++;
                    } catch (err) {
                        // A thrown error triggers retry/DLQ in pg-boss
                        this.metrics.retries++;
                        this.metrics.errors++;
                        throw err;
                    }
                }
                // Throw inside handler to trigger retry; returning resolves completions
            }
        );
    }

    // Optional multi-topic methods (for subsystems like ASR)
    async publishTo(
        topic: string,
        msg: object,
        opts?: { timeoutSec?: number }
    ) {
        if (!this.boss) await this.start();
        const expireInSeconds = Math.max(
            1,
            Math.floor(
                opts?.timeoutSec ??
                    Number(
                        readIntEnv(
                            'QUEUE_VISIBILITY_SEC',
                            this.opts.visibilityTimeoutSec ?? 90
                        )
                    )
            )
        );
        const retryLimit = Number(
            readIntEnv('QUEUE_MAX_ATTEMPTS', this.opts.maxAttempts ?? 3)
        );
        const dlq = `${topic}.dlq`;
        try {
            await this.boss!.createQueue(topic, {
                name: topic,
                expireInSeconds,
                retryLimit,
                deadLetter: dlq,
            });
        } catch {}
        try {
            await this.boss!.createQueue(dlq, {
                name: dlq,
                expireInSeconds: expireInSeconds * 2,
                retryLimit: 0,
            });
        } catch {}
        await this.boss!.send(topic, msg, {
            expireInSeconds,
            retryLimit,
            retryBackoff: true,
            deadLetter: dlq,
        });
        this.metrics.publishes++;
    }

    async consumeFrom(topic: string, handler: (msg: any) => Promise<void>) {
        if (!this.boss) await this.start();
        const batchSize = Number(
            readIntEnv('QUEUE_CONCURRENCY', this.opts.concurrency ?? 4)
        );
        await this.boss!.work<any>(topic, { batchSize }, async (jobs) => {
            for (const job of jobs) {
                this.metrics.claims++;
                try {
                    await handler(job.data as any);
                    this.metrics.completes++;
                } catch (err) {
                    this.metrics.retries++;
                    this.metrics.errors++;
                    throw err;
                }
            }
        });
    }

    async shutdown(): Promise<void> {
        if (this.boss) {
            await this.boss.stop();
            this.boss = undefined;
        }
    }

    async health(): Promise<{ ok: boolean; error?: string }> {
        try {
            if (!this.boss) await this.start();
            // Simple ping by fetching the state; if it throws, not healthy
            // getQueue takes a name and returns settings; use topic
            await this.boss!.getQueue(this.topic);
            return { ok: true };
        } catch (e) {
            return {
                ok: false,
                error: e instanceof Error ? e.message : String(e),
            };
        }
    }

    getMetrics() {
        return { ...this.metrics };
    }
}
````

## File: src/queue/types.ts
````typescript
export type QueuePriority = 'fast' | 'normal' | 'bulk';

export interface QueueMessage {
    jobId: string;
    priority?: QueuePriority;
}

export interface QueueAdapter {
    publish(msg: QueueMessage, opts?: { timeoutSec?: number }): Promise<void>;
    consume(handler: (msg: QueueMessage) => Promise<void>): Promise<void>;
    // Optional multi-topic API for subsystems (e.g., ASR)
    publishTo?(
        topic: string,
        msg: object,
        opts?: { timeoutSec?: number }
    ): Promise<void>;
    consumeFrom?(
        topic: string,
        handler: (msg: any) => Promise<void>
    ): Promise<void>;
    shutdown(): Promise<void>;
    start(): Promise<void>;
    health(): Promise<{ ok: boolean; error?: string }>;
    getMetrics(): {
        publishes: number;
        claims: number;
        completes: number;
        retries: number;
        errors: number;
        dlq: number;
    };
}

// Queue topics used in the system
export const QUEUE_TOPIC_CLIPS = 'clips';
export const QUEUE_TOPIC_ASR = 'asr';
````

## File: README.md
````markdown
# clipper

High‑performance media clipping pipeline (upload → clip (FFmpeg) → store → status/result API) built on Bun, Postgres (Drizzle), pg-boss, and Supabase Storage.

## ✨ Features (Current Layer Status)

| Layer              | Status      | Notes                                                  |
| ------------------ | ----------- | ------------------------------------------------------ |
| 0 Foundations      | ✅          | Types, schemas, logger, errors, time utils             |
| 1 Data Layer       | ✅          | Drizzle schema + repos                                 |
| 2 Queue Layer      | ✅          | pg-boss adapter + DLQ consumer skeleton                |
| 3 Media IO         | ✅          | Upload + YouTube (gated) resolvers with SSRF guard     |
| 4 FFmpeg Clipper   | ✅          | Stream-copy + fallback re-encode with progress         |
| 5 ASR (Whisper)    | ⏳          | Planned                                                |
| 6 Worker Runtime   | ✅ (basic)  | Integrated clipper & progress persistence              |
| 7 API              | 🚧          | Create job present; status/result endpoints upcoming   |
| 8 Storage Delivery | Partial     | Upload result video wired; signed result retrieval TBD |
| 9 Cleanup          | ✅          | TTL cleanup script                                     |
| 10 Observability   | Minimal     | Basic logging; metrics TODO                            |
| 11 Security        | Minimal     | Redaction + SSRF allowlist; rate limiting TBD          |
| 12 Docs / SDK      | In Progress | This README + more docs being added                    |
| 13 UI              | Planned     | Simple demo page                                       |

## 🧩 Architecture (High Level Flow)

1. Client submits job (upload source key or YouTube URL + time range).
2. API persists job (status=queued) → enqueues message.
3. Worker consumes job → resolves source locally → runs FFmpeg clipper (progress streamed) → uploads result → marks done.
4. Client polls /jobs/:id (status + progress) and later fetches signed result URL.

## ⚙️ Requirements

You need these installed locally:

-   Bun >= 1.2.x
-   ffmpeg & ffprobe in PATH
-   Postgres (or Supabase) reachable via `DATABASE_URL`

Optional:

-   yt-dlp (if enabling YouTube resolver via `ENABLE_YTDLP=true`)

## 🚀 Quick Start

```bash
# 1. Install deps
bun install

# 2. Copy & edit environment
cp .env.example .env
# Fill in DATABASE_URL, SUPABASE_* values, etc.

# 3. Run migrations (drizzle-kit configured)
# (Add migration command here when generated) – schema currently bootstrap via SQL file.

# 4. Start API (once endpoints added) & worker in separate terminals
bun run src/api/index.ts &
bun run src/worker/index.ts
```

## 🔑 Key Environment Variables

| Var                                      | Purpose                                         | debug | info | warn  | error |
| ---------------------------------------- | ----------------------------------------------- | ----- | ---- | ----- | ----- |
| DATABASE_URL                             | Postgres / pg-boss + Drizzle                    |
| SCRATCH_DIR                              | Local fast storage for source + clip temp files |
| SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY | Storage access                                  |
| SUPABASE_STORAGE_BUCKET                  | Bucket with sources/results prefixes            |
| ENABLE_YTDLP                             | Enable YouTube resolver                         |
| MAX_CLIP_INPUT_DURATION_SEC              | Guardrail on input length                       |
| MAX_INPUT_MB                             | Guardrail on input file size                    |
| SIGNED_URL_TTL_SEC                       | TTL for signed result URLs                      |
| LOG_LEVEL                                | debug                                           | info  | warn | error |

See `.env.example` for the complete list.

## 🎬 FFmpeg Clipper

Fast path attempts `-ss -to -c copy -movflags +faststart`. If container/keyframe layout prevents accurate copy or copy fails, it falls back to `libx264 + aac (veryfast)` ensuring a valid playable MP4. Progress is parsed from `-progress pipe:1` output and persisted to the DB in the worker with lightweight debouncing.

## 📦 Storage Layout

```
sources/{jobId}/source.ext
results/{jobId}/clip.mp4
results/{jobId}/clip.srt (future)
```

## 🧪 Testing

Unit & integration tests (vitest):

```bash
bunx vitest
```

FFmpeg integration tests polyfill Bun globals when run under vitest’s Node environment. Ensure ffmpeg/ffprobe exist for those tests.

## 🛠 Development Tips

-   Use `LOG_LEVEL=debug` while iterating on worker features.
-   Clip accuracy: if users report off-by drift in copy mode, fallback re-encode path guarantees frame-accurate boundaries.
-   Add new job lifecycle events via `events.add({ type, data })` for richer status endpoints.

## 🔒 Security Notes

-   SSRF guard + allowlist enforced for YouTube URLs.
-   Secrets redacted in logs (see `redact.ts`).
-   Future: API keys, rate limits.

## 📘 Next Work

1. Expose GET /api/jobs/:id + /api/jobs/:id/result
2. Signed URL issuance for results
3. Basic metrics (progress histograms, queue depth)
4. Whisper ASR integration

## 📝 License

Currently unspecified (internal / WIP). Add an OSS license before public release.

---

Generated with ❤️ using Bun.
````

## File: planning/ffmpeg/tasks.md
````markdown
artifact_id: 93191111-1111-4111-b111-111111111111
content_type: text/markdown
title: tasks.md

# FFmpeg Service Implementation Tasks

This document breaks down the work required to implement the FFmpeg Service (Clipper) as described in the requirements and design documents.

### ✅ Task Checklist

-   [x] **1. Create Project Structure**

    -   [x] Create the main directory: `src/ffmpeg`.
    -   [x] Create the following files:
        -   `src/ffmpeg/index.ts`
        -   `src/ffmpeg/types.ts`
        -   `src/ffmpeg/clipper.ts`
        -   `src/ffmpeg/progress.ts`

-   [x] **2. Implement Core Types**

    -   **File**: `src/ffmpeg/types.ts`
    -   [x] Define and export the `ClipResult`, `ClipArgs`, and `Clipper` interfaces as specified in the design document.
    -   **Requirements**: 1.1, 2.1

-   [x] **3. Implement Progress Parser**

    -   **File**: `src/ffmpeg/progress.ts`
    -   [x] Implement the `parseFfmpegProgress` async generator function.
    -   [x] It accepts a `ReadableStream` and `totalDurationSec`.
    -   [x] It parses `out_time_ms=` lines and yields monotonic percentage values.
    -   [x] It yields `100` upon completion.
    -   **Requirements**: 2.1, 2.2, 2.3

-   [x] **4. Implement the Clipper Service**

    -   **File**: `src/ffmpeg/clipper.ts`
    -   [x] Create the `BunClipper` class implementing the `Clipper` interface.
    -   [x] Implement the `clip` method.
    -   [ ] **4.1. Stream-Copy Logic**:
    -   [x] Use `Bun.spawn` to execute the `ffmpeg` stream-copy command.
    -   [x] Pipe the process's progress stream to the `parseFfmpegProgress` utility.
    -   [x] Check the exit code. If successful, return the local path and progress stream.
    -   [ ] **4.2. Re-encode Fallback Logic**:
    -   [x] If the stream-copy process fails (non-zero exit code), log the error and trigger the re-encode command.
    -   [x] Execute the `ffmpeg` re-encode command using `Bun.spawn`.
    -   [x] Pipe its progress stream to the parser.
    -   [x] If this process also fails, throw a `ServiceError`.
    -   [ ] **4.3. File Management**:
    -   [x] Ensure the output directory inside `SCRATCH_DIR` is created before spawning FFmpeg.
    -   **Requirements**: 1.1, 1.2, 1.3, 1.4, 1.5

-   [x] **5. Integrate Clipper into Worker**

    -   **File**: `src/worker/index.ts`
    -   [x] Import and instantiate `BunClipper`.
    -   [x] In the `queue.consume` handler, after resolving the source file:
        -   [x] Call `clipper.clip()`.
        -   [x] Use a `for await...of` loop to consume the `progress$` stream.
        -   [x] Inside the loop, call `jobs.updateProgress()` and `events.add()`.
        -   [x] On successful completion, upload the resulting clip using `StorageRepo`.
        -   [x] Update the job status to `done` and set `resultVideoKey`.
        -   [x] Implement `try...catch` around the clipping logic to handle `ServiceError` and mark the job as `failed`.
        -   [x] Add a `finally` block to ensure temporary files are cleaned up.
    -   **Requirements**: 3.1, 3.2, 3.3, 3.4, 3.5

-   [x] **6. Add to Barrel File**

    -   **File**: `src/ffmpeg/index.ts`
    -   [x] Export all public interfaces and the `BunClipper` class.

-   [x] **7. (Optional but Recommended) Integration Testing**

    -   [x] Create `src/ffmpeg/ffmpeg.integration.test.ts`.
    -   [x] Add a test case for a successful stream copy.
    -   [x] Add a test to verify progress reporting.

-   [x] **8. Documentation**
    -   [x] Add JSDoc comments to all public functions and interfaces.
    -   [x] Update the main `README.md` or other relevant docs if necessary to mention that `ffmpeg` is now a required dependency.
````

## File: planning/layers.md
````markdown
# 0) Foundations (Contracts & Utilities)

**What:** Shared TypeScript types, Zod schemas, time parsing, config loader, error envelope, job state machine.
**Deliverables:**

-   `@clipper/contracts` (types + Zod → optional OpenAPI)
-   `@clipper/common` (env loader, logger, error helper, time utils)
    **DoD:** Types compile, schemas validate, example payloads round-trip.

# 1) Data Layer (Supabase + Drizzle)

**What:** Postgres schema + migrations; Supabase Storage buckets.
**Deliverables:**

-   Tables: `jobs`, `job_events`, (optional) `api_keys`
-   Indices & retention TTLs; storage buckets `sources/`, `results/`
-   Drizzle models + repo functions
    **DoD:** Can create/read/update job rows locally; storage write/read works with signed URLs.

# 2) Queue Layer (pick one and commit)

**What:** Abstraction + concrete queue. Recommend **pg-boss** (Postgres) to start; Redis Streams later if needed.
**Deliverables:**

-   `Queue.publish()`, `Queue.consume()`, ack/retry/backoff, priorities
-   Visibility timeout & dead-letter handling
    **DoD:** Jobs published/claimed/acked; retries capped; unit tests simulate crash/resume.

# 3) Media IO (Source Resolver)

**What:** Resolve the input media to a local file path.
**Deliverables:**

-   Upload path: fetch from Supabase Storage to NVMe
-   (Optional, gated) YouTube: `yt-dlp` resolver behind `ENABLE_YTDLP`
-   SSRF guard + size/duration caps via `ffprobe`
    **DoD:** Given a job, returns a local source file or a clear error.

# 4) FFmpeg Service (Clipper)

**What:** The fast clip path with fallback.
**Deliverables:**

-   Stream-copy first: `-ss -to -c copy`
-   Fallback re-encode: x264 veryfast; `-movflags +faststart`
-   Progress parser (stderr `time=` → % of segment)
    **DoD:** Generates correct MP4 on both paths; progress updates emitted.

# 5) ASR Service (Groq Whisper)

**What:** Subtitles for the requested segment only.
**Deliverables:**

-   Client for Groq API (model selection via env)
-   Segment extraction (`-vn -ac 1 -ar 16k`) → send to Groq → `.srt` writer
-   Burn-in filter (`subtitles=`) pipeline option
    **DoD:** For a job with subs, returns valid `.srt`; optional burned-in MP4 verified.

# 6) Worker Runtime

**What:** The long-running job processor.
**Deliverables:**

-   Concurrency control; prefetch/prefork settings
-   Heartbeats → DB (`progress`, `last_heartbeat_at`)
-   Idempotency: short-circuit if outputs exist in Storage
-   Structured state transitions: `queued → processing → done|failed` + retries
    **DoD:** Can drain a queue; survives crashes; meets SLOs on sample load.

# 7) API (Bun + Elysia)

**What:** Public REST to submit, check, and fetch results.
**Endpoints:**

-   `POST /api/jobs` (validate → persist → enqueue)
-   `POST /api/uploads` or `POST /api/jobs/upload` (multipart)
-   `GET /api/jobs/:id` (status/progress)
-   `GET /api/jobs/:id/result` (signed URLs)
    **Cross-cutting:** rate limit, CORS, ADMIN_ENABLED, consistent error envelope.
    **DoD:** E2E happy path from request → downloadable clip.

# 8) Storage Output & Delivery

**What:** Ship outputs to Supabase Storage and sign URLs.
**Deliverables:**

-   Result keys: `results/{jobId}/clip.mp4`, `clip.srt`
-   Signed URL helper with short TTL
-   Optional CDN headers
    **DoD:** Download works from a cold client via signed link.

# 9) Retention & Cleanup

**What:** TTL deletion of old artifacts and rows.
**Deliverables:**

-   Scheduled task (cron) removing expired Storage objects + DB rows
-   Safety: dry-run mode, rate-limited deletes
    **DoD:** Items older than TTL disappear automatically; metrics confirm.

# 10) Observability & Ops

**What:** Know what’s happening and when it breaks.
**Deliverables:**

-   `/healthz`, `/metrics` (Prometheus)
-   Job duration histograms; queue depth; Groq latency; S3 upload latency
-   Correlated logs by jobId; redaction of secrets
    **DoD:** Dash shows current queue, success rate, P95s; alerts fire on backlog/fail rate.

# 11) Security & Abuse Controls

**What:** Keep it up and clean.
**Deliverables:**

-   IP rate limits; max concurrent jobs per IP/key
-   SSRF protections; input URL allowlist when fetch is enabled
-   API key support for programmatic access (optional)
    **DoD:** Load tests don’t DOS the node; malicious URLs are rejected.

# 12) Docs & SDK Stubs

**What:** Make it usable without you.
**Deliverables:**

-   Markdown API reference + curl examples
-   Optional OpenAPI from Zod
-   Tiny TS client (`createJob`, `getStatus`, `getResult`)
    **DoD:** A new dev can integrate in <30 minutes.

# 13) (Optional) Minimal UI

**What:** A 1-page tool to demo and dogfood.
**Deliverables:**

-   URL/upload inputs, time pickers, “Subtitles/Burn-in” toggles
-   Job card with live polling + download
    **DoD:** Non-dev can create a clip in under a minute.

---

## Build Order (fastest path to value)

1. **0,1,2** Foundations + DB + Queue
2. **4** FFmpeg clipper (upload-only)
3. **6** Worker runtime with progress → **7** API (create/status/result)
4. **8** Storage delivery + signed URLs
5. **9** Cleanup + **10** Observability
6. **5** Groq Whisper ASR + burn-in
7. **3** (optional) YouTube resolver gated by env
8. **12/13** Docs + tiny UI

Not built

Minimal UI

---

## Clear Interfaces (keep seams loose)

```ts
// contracts
type SourceType = 'upload' | 'youtube';
type JobStatus = 'queued' | 'processing' | 'done' | 'failed';

interface CreateJobInput {
    sourceType: SourceType;
    youtubeUrl?: string;
    uploadKey?: string; // Supabase path
    start: string; // HH:MM:SS(.ms)
    end: string;
    withSubtitles: boolean;
    burnSubtitles: boolean;
    subtitleLang?: 'auto' | string;
}

interface JobRecord {
    id: string;
    status: JobStatus;
    progress: number;
    resultVideoKey?: string;
    resultSrtKey?: string;
    error?: string;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
}

// queue
interface Queue {
    publish(jobId: string): Promise<void>;
    consume(handler: (jobId: string) => Promise<void>): Promise<void>;
}

// services
interface SourceResolver {
    toLocal(
        job: JobRecord
    ): Promise<{ localPath: string; cleanup: () => Promise<void> }>;
}
interface Clipper {
    clip(args: {
        input: string;
        startSec: number;
        endSec: number;
    }): Promise<{ localPath: string; progress$: AsyncIterable<number> }>;
}
interface ASR {
    transcribe(args: {
        input: string;
        startSec: number;
        endSec: number;
        lang?: string;
    }): Promise<{ srtPath: string }>;
}
interface Storage {
    upload(localPath: string, key: string): Promise<void>;
    sign(key: string, ttlSec: number): Promise<string>;
    remove(key: string): Promise<void>;
}
```

---

## Definition of Done for the whole project

-   Meets SLOs: P95 ≤ 30s (no subs) / ≤ 90s (with subs) for 30s clips on target hardware.
-   Handles 100+ concurrent stream-copy jobs on a single node without errors.
-   Clean error envelopes; retries + idempotency verified.
-   Docs published; minimal UI demo works end-to-end.
````

## File: src/data/db/repos.ts
````typescript
import { desc, eq, and } from 'drizzle-orm';
import { createDb } from './connection';
import { jobEvents, jobs, asrJobs, asrArtifacts } from './schema';
import type { JobStatus } from '@clipper/contracts';
import { createLogger, noopMetrics, type Metrics } from '../../common/index';
import type {
    JobEvent as RepoJobEvent,
    JobRow,
    JobEventsRepository,
    JobsRepository,
} from '../repo';
import type {
    AsrJobRow,
    AsrArtifactRow,
    AsrJobsRepository,
    AsrArtifactsRepository,
} from '../repo';

export class DrizzleJobsRepo implements JobsRepository {
    private readonly logger = createLogger('info').with({ comp: 'jobsRepo' });
    constructor(
        private readonly db = createDb(),
        private readonly metrics: Metrics = noopMetrics
    ) {}

    async create(
        row: Omit<JobRow, 'createdAt' | 'updatedAt'>
    ): Promise<JobRow> {
        const start = Date.now();
        const [rec] = await this.db
            .insert(jobs)
            .values({
                id: row.id,
                status: row.status,
                progress: row.progress,
                sourceType: row.sourceType,
                sourceKey: row.sourceKey,
                sourceUrl: row.sourceUrl,
                startSec: row.startSec,
                endSec: row.endSec,
                withSubtitles: row.withSubtitles,
                burnSubtitles: row.burnSubtitles,
                subtitleLang: row.subtitleLang,
                resultVideoKey: row.resultVideoKey,
                resultSrtKey: row.resultSrtKey,
                errorCode: row.errorCode,
                errorMessage: row.errorMessage,
                expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
            })
            .returning();
        const out = toJobRow(rec);
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'jobs.create',
        });
        this.logger.info('job created', { jobId: out.id });
        return out;
    }

    async get(id: string): Promise<JobRow | null> {
        const start = Date.now();
        const [rec] = await this.db
            .select()
            .from(jobs)
            .where(eq(jobs.id, id))
            .limit(1);
        const out = rec ? toJobRow(rec) : null;
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'jobs.get',
        });
        return out;
    }

    async update(id: string, patch: Partial<JobRow>): Promise<JobRow> {
        const start = Date.now();
        const [rec] = await this.db
            .update(jobs)
            .set(toJobsPatch(patch))
            .where(eq(jobs.id, id))
            .returning();
        if (!rec) throw new Error('NOT_FOUND');
        const row = toJobRow(rec);
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'jobs.update',
        });
        this.logger.info('job updated', { jobId: row.id });
        return row;
    }

    async listByStatus(
        status: JobStatus,
        limit = 50,
        offset = 0
    ): Promise<JobRow[]> {
        const start = Date.now();
        const rows = await this.db
            .select()
            .from(jobs)
            .where(eq(jobs.status, status))
            .orderBy(desc(jobs.createdAt))
            .limit(limit)
            .offset(offset);
        const out = rows.map(toJobRow);
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'jobs.listByStatus',
        });
        return out;
    }

    async transition(
        id: string,
        next: JobStatus,
        event?: { type?: string; data?: Record<string, unknown> }
    ): Promise<JobRow> {
        const start = Date.now();
        const res = await this.db.transaction(async (tx) => {
            const [updated] = await tx
                .update(jobs)
                .set({ status: next, updatedAt: new Date() })
                .where(eq(jobs.id, id))
                .returning();
            if (!updated) throw new Error('NOT_FOUND');

            if (event) {
                await tx.insert(jobEvents).values({
                    jobId: id,
                    type: event.type ?? `status:${next}`,
                    data: event.data ?? null,
                });
            }
            return toJobRow(updated);
        });
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'jobs.transition',
        });
        this.logger.info('job transitioned', { jobId: id, next });
        return res;
    }
}

export class DrizzleJobEventsRepo implements JobEventsRepository {
    constructor(
        private readonly db = createDb(),
        private readonly metrics: Metrics = noopMetrics
    ) {}

    async add(evt: RepoJobEvent): Promise<void> {
        const start = Date.now();
        await this.db.insert(jobEvents).values({
            jobId: evt.jobId,
            ts: new Date(evt.ts),
            type: evt.type,
            data: evt.data ?? null,
        });
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'events.add',
        });
    }

    async list(
        jobId: string,
        limit = 100,
        offset = 0
    ): Promise<RepoJobEvent[]> {
        const start = Date.now();
        const rows = await this.db
            .select()
            .from(jobEvents)
            .where(eq(jobEvents.jobId, jobId))
            .orderBy(desc(jobEvents.ts))
            .limit(limit)
            .offset(offset);
        const out = rows.map((r) => ({
            jobId: r.jobId,
            ts: r.ts.toISOString(),
            type: r.type,
            data: (r.data as Record<string, unknown> | null) ?? undefined,
        }));
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'events.list',
        });
        return out;
    }
}

// ASR Repositories
export class DrizzleAsrJobsRepo implements AsrJobsRepository {
    private readonly logger = createLogger('info').with({
        comp: 'asrJobsRepo',
    });
    constructor(
        private readonly db = createDb(),
        private readonly metrics: Metrics = noopMetrics
    ) {}

    async create(
        row: Omit<AsrJobRow, 'createdAt' | 'updatedAt' | 'status'> &
            Partial<Pick<AsrJobRow, 'status'>>
    ): Promise<AsrJobRow> {
        const start = Date.now();
        const [rec] = await this.db
            .insert(asrJobs)
            .values({
                id: row.id,
                clipJobId: row.clipJobId,
                sourceType: row.sourceType,
                sourceKey: row.sourceKey,
                mediaHash: row.mediaHash,
                modelVersion: row.modelVersion,
                languageHint: row.languageHint,
                detectedLanguage: row.detectedLanguage,
                durationSec: row.durationSec,
                status: row.status ?? 'queued',
                errorCode: row.errorCode,
                errorMessage: row.errorMessage,
                completedAt: row.completedAt ? new Date(row.completedAt) : null,
                expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
            })
            .returning();
        const out = toAsrJobRow(rec);
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'asrJobs.create',
        });
        this.logger.info('asr job created', { asrJobId: out.id });
        return out;
    }

    async get(id: string): Promise<AsrJobRow | null> {
        const start = Date.now();
        const [rec] = await this.db
            .select()
            .from(asrJobs)
            .where(eq(asrJobs.id, id))
            .limit(1);
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'asrJobs.get',
        });
        return rec ? toAsrJobRow(rec) : null;
    }

    async getReusable(
        mediaHash: string,
        modelVersion: string
    ): Promise<(AsrJobRow & { artifacts: AsrArtifactRow[] }) | null> {
        const start = Date.now();
        const [rec] = await this.db
            .select()
            .from(asrJobs)
            .where(
                and(
                    eq(asrJobs.mediaHash, mediaHash),
                    eq(asrJobs.modelVersion, modelVersion),
                    eq(asrJobs.status, 'done')
                )
            )
            .limit(1);
        if (!rec) return null;
        const artifacts = await this.db
            .select()
            .from(asrArtifacts)
            .where(eq(asrArtifacts.asrJobId, rec.id));
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'asrJobs.getReusable',
        });
        return {
            ...toAsrJobRow(rec),
            artifacts: artifacts.map(toAsrArtifactRow),
        };
    }

    async patch(id: string, patch: Partial<AsrJobRow>): Promise<AsrJobRow> {
        const start = Date.now();
        const [rec] = await this.db
            .update(asrJobs)
            .set(toAsrJobsPatch(patch))
            .where(eq(asrJobs.id, id))
            .returning();
        if (!rec) throw new Error('NOT_FOUND');
        const row = toAsrJobRow(rec);
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'asrJobs.patch',
        });
        this.logger.info('asr job patched', { asrJobId: row.id });
        return row;
    }
}

export class DrizzleAsrArtifactsRepo implements AsrArtifactsRepository {
    constructor(
        private readonly db = createDb(),
        private readonly metrics: Metrics = noopMetrics
    ) {}

    async put(artifact: AsrArtifactRow): Promise<void> {
        const start = Date.now();
        await this.db
            .insert(asrArtifacts)
            .values({
                asrJobId: artifact.asrJobId,
                kind: artifact.kind,
                storageKey: artifact.storageKey,
                sizeBytes: artifact.sizeBytes,
            })
            .onConflictDoUpdate({
                target: [asrArtifacts.asrJobId, asrArtifacts.kind],
                set: {
                    storageKey: artifact.storageKey,
                    sizeBytes: artifact.sizeBytes,
                },
            });
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'asrArtifacts.put',
        });
    }

    async list(asrJobId: string): Promise<AsrArtifactRow[]> {
        const start = Date.now();
        const rows = await this.db
            .select()
            .from(asrArtifacts)
            .where(eq(asrArtifacts.asrJobId, asrJobId));
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'asrArtifacts.list',
        });
        return rows.map(toAsrArtifactRow);
    }
}

function toJobRow(j: any): JobRow {
    return {
        id: j.id,
        status: j.status,
        progress: j.progress,
        sourceType: j.sourceType,
        sourceKey: j.sourceKey ?? undefined,
        sourceUrl: j.sourceUrl ?? undefined,
        startSec: j.startSec,
        endSec: j.endSec,
        withSubtitles: j.withSubtitles,
        burnSubtitles: j.burnSubtitles,
        subtitleLang: j.subtitleLang ?? undefined,
        resultVideoKey: j.resultVideoKey ?? undefined,
        resultSrtKey: j.resultSrtKey ?? undefined,
        errorCode: j.errorCode ?? undefined,
        errorMessage: j.errorMessage ?? undefined,
        createdAt: j.createdAt.toISOString(),
        updatedAt: j.updatedAt.toISOString(),
        expiresAt: j.expiresAt ? j.expiresAt.toISOString() : undefined,
    };
}

function toJobsPatch(patch: Partial<JobRow>) {
    const out: any = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (k === 'expiresAt' && v) out[k] = new Date(v as string);
        else out[k] = v as any;
    }
    return out;
}

function toAsrJobRow(j: any): AsrJobRow {
    return {
        id: j.id,
        clipJobId: j.clipJobId ?? undefined,
        sourceType: j.sourceType,
        sourceKey: j.sourceKey ?? undefined,
        mediaHash: j.mediaHash,
        modelVersion: j.modelVersion,
        languageHint: j.languageHint ?? undefined,
        detectedLanguage: j.detectedLanguage ?? undefined,
        durationSec: j.durationSec ?? undefined,
        status: j.status,
        errorCode: j.errorCode ?? undefined,
        errorMessage: j.errorMessage ?? undefined,
        createdAt: j.createdAt.toISOString(),
        updatedAt: j.updatedAt.toISOString(),
        completedAt: j.completedAt ? j.completedAt.toISOString() : undefined,
        expiresAt: j.expiresAt ? j.expiresAt.toISOString() : undefined,
    };
}

function toAsrJobsPatch(patch: Partial<AsrJobRow>) {
    const out: any = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (k.endsWith('At') && v) out[k] = new Date(v as string);
        else out[k] = v as any;
    }
    return out;
}

function toAsrArtifactRow(a: any): AsrArtifactRow {
    return {
        asrJobId: a.asrJobId,
        kind: a.kind,
        storageKey: a.storageKey,
        sizeBytes: a.sizeBytes ?? undefined,
        createdAt: a.createdAt.toISOString(),
    };
}
````

## File: src/data/storage.ts
````typescript
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readEnv } from '../common/index';

export const storageKeys = {
    source: (jobId: string, ext: string) =>
        `sources/${jobId}/source.${ext.replace(/^\./, '')}`,
    resultVideo: (jobId: string) => `results/${jobId}/clip.mp4`,
    resultSrt: (jobId: string) => `results/${jobId}/clip.srt`,
    transcriptSrt: (ownerId: string) =>
        `results/${ownerId}/transcript/clip.srt`,
    transcriptText: (ownerId: string) =>
        `results/${ownerId}/transcript/clip.txt`,
    transcriptJson: (ownerId: string) =>
        `results/${ownerId}/transcript/clip.json`,
};

export interface StorageRepo {
    upload(localPath: string, key: string, contentType?: string): Promise<void>;
    sign(key: string, ttlSec?: number): Promise<string>;
    remove(key: string): Promise<void>;
    download(key: string, toPath?: string): Promise<string>; // returns local path
}

export type SupabaseStorageOptions = {
    url?: string;
    serviceRoleKey?: string;
    bucket?: string;
    defaultTtlSec?: number; // default 600 (10 minutes)
    client?: SupabaseClient; // optional injection for testing
};

export function createSupabaseStorageRepo(
    opts: SupabaseStorageOptions = {}
): StorageRepo {
    const url = opts.url ?? readEnv('SUPABASE_URL');
    const key = opts.serviceRoleKey ?? readEnv('SUPABASE_SERVICE_ROLE_KEY');
    const bucket = opts.bucket ?? readEnv('SUPABASE_STORAGE_BUCKET');
    const ttlStr = readEnv('SIGNED_URL_TTL_SEC');
    const defaultTtlSec = opts.defaultTtlSec ?? (ttlStr ? Number(ttlStr) : 600);

    if (!url || !key || !bucket) {
        throw new Error(
            'Supabase storage not configured: require SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET'
        );
    }

    const client = opts.client ?? createClient(url, key);
    return new SupabaseStorageRepo(client, bucket, defaultTtlSec);
}

class SupabaseStorageRepo implements StorageRepo {
    constructor(
        private readonly supabase: SupabaseClient,
        private readonly bucket: string,
        private readonly defaultTtlSec: number
    ) {}

    async upload(
        localPath: string,
        key: string,
        contentType?: string
    ): Promise<void> {
        const type = contentType ?? guessContentType(key);
        const bun: any = (globalThis as any).Bun;
        const forceNode = readEnv('FORCE_NODE_FS') === '1';
        let blob: Blob;
        if (!forceNode && bun?.file) {
            const file = bun.file(localPath);
            if (!(await file.exists())) {
                throw new Error(`FILE_NOT_FOUND: ${localPath}`);
            }
            blob = new Blob([await file.arrayBuffer()], { type });
        } else {
            const { readFile } = await import('node:fs/promises');
            const data = await readFile(localPath);
            blob = new Blob([data], { type });
        }
        const { error } = await this.supabase.storage
            .from(this.bucket)
            .upload(key, blob, { upsert: true, contentType: blob.type });
        if (error) throw new Error(`STORAGE_UPLOAD_FAILED: ${error.message}`);
    }

    async sign(key: string, ttlSec?: number): Promise<string> {
        const { data, error } = await this.supabase.storage
            .from(this.bucket)
            .createSignedUrl(key, ttlSec ?? this.defaultTtlSec);
        if (error || !data?.signedUrl)
            throw new Error(
                `STORAGE_SIGN_FAILED: ${error?.message ?? 'unknown'}`
            );
        return data.signedUrl;
    }

    async remove(key: string): Promise<void> {
        const { error } = await this.supabase.storage
            .from(this.bucket)
            .remove([key]);
        if (error) throw new Error(`STORAGE_REMOVE_FAILED: ${error.message}`);
    }

    async download(key: string, toPath?: string): Promise<string> {
        const url = await this.sign(key, 60);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`STORAGE_DOWNLOAD_FAILED: ${res.status}`);
        const ab = await res.arrayBuffer();
        const out = toPath ?? `/tmp/${key.split('/').pop() || 'asset.bin'}`;
        await Bun.write(out, new Uint8Array(ab));
        return out;
    }
}

function guessContentType(key: string): string {
    const lower = key.toLowerCase();
    if (lower.endsWith('.mp4')) return 'video/mp4';
    if (lower.endsWith('.mkv')) return 'video/x-matroska';
    if (lower.endsWith('.mov')) return 'video/quicktime';
    if (lower.endsWith('.webm')) return 'video/webm';
    if (lower.endsWith('.srt')) return 'application/x-subrip';
    if (lower.endsWith('.txt')) return 'text/plain; charset=utf-8';
    if (lower.endsWith('.json')) return 'application/json';
    return 'application/octet-stream';
}
````

## File: package.json
````json
{
    "name": "clipper",
    "module": "index.ts",
    "type": "module",
    "private": true,
    "scripts": {
        "test": "bunx vitest run",
        "db:generate": "bunx drizzle-kit generate --config=drizzle.config.ts",
        "db:migrate": "bunx drizzle-kit migrate --config=drizzle.config.ts",
        "db:push": "bunx drizzle-kit push --config=drizzle.config.ts"
    },
    "devDependencies": {
        "@types/bun": "latest"
    },
    "peerDependencies": {
        "typescript": "^5"
    },
    "dependencies": {
        "@elysiajs/cors": "^1.3.3",
        "@supabase/supabase-js": "^2.54.0",
        "@types/pg": "^8.15.5",
        "dotenv": "^17.2.1",
        "drizzle-kit": "^0.31.4",
        "drizzle-orm": "^0.44.4",
        "elysia": "^1.3.8",
        "pg": "^8.16.3",
        "pg-boss": "^10.3.2",
        "zod": "^4.0.17",
        "zod-to-openapi": "^0.2.1"
    }
}
````

## File: planning/asr/tasks.md
````markdown
# ASR Service Tasks

artifact_id: 39d0ca49-8c65-44c0-8f8e-5fd9b3180c3c

Mappings: Req numbers refer to ASR requirements document.

## 1. Database & Schema

-   [x] Add Drizzle schema additions (Req: 1,2,3,4,8,9,10,11)
    -   [x] Create tables: asr_jobs, asr_artifacts
    -   [x] Add unique index (media_hash, model_version) where status='done'
    -   [x] Generate migration SQL
    -   [x] Update drizzle meta snapshot (journal updated; snapshot auto-updated next migrate)
-   [x] Repository interfaces (Req: 1,3,5,8,9,10)
    -   [x] Implement AsrJobsRepository in `src/data/db/repos.ts`
    -   [x] Implement AsrArtifactsRepository
    -   [x] Add getReusable(mediaHash, modelVersion)
    -   [x] Unit tests with DB (integration test asr.repos.integration.test.ts)

## 2. Provider Abstraction

-   [x] Define provider interfaces/types (Req: 5,6)
    -   [x] Add `src/asr/provider.ts` with AsrProvider, segment/result types
    -   [x] Add error class ProviderHttpError
-   [x] GroqWhisperProvider (Req: 6,7)
    -   [x] Implement multipart POST per docs with timeout & abort
    -   [x] Map verbose_json to segments
    -   [x] Retry wrapper (exponential backoff, max 3) for 5xx/429/network
    -   [x] Unit tests (mock fetch)

## 3. Formatting & Artifacts

-   [x] TranscriptFormatter (Req: 5)
    -   [x] Implement merge & SRT generation logic
    -   [x] Implement plain text and optional JSON builder
    -   [x] Unit tests for gap merge, timestamp rounding, control char stripping
-   [x] Artifact builder integration (Req: 5,10)
    -   [x] Function buildArtifacts returning { srt, text, json? }

## 4. Facade & Caching

-   [ ] ASR Facade (Req: 1,5,10)
    -   [x] Implement request() computing mediaHash (SHA256 stream)
    -   [x] Reuse existing completed job via getReusable
    -   [x] Create new asr_job row; enqueue message
    -   [x] Update worker clipping pipeline to call facade when subtitleLang=auto
    -   [x] Tests: reuse path vs new path

## 5. Queue Integration

-   [ ] Queue topic (Req: 1,3)
    -   [x] Add ASR queue name constant (e.g., 'asr') in `src/queue/types.ts`
    -   [x] Extend pgboss adapter subscribe for ASR job handler
-   [ ] Message shape & validation (Req: 1)
    -   [x] Define zod schema for ASR queue payload
    -   [x] Tests for invalid payload rejection

## 6. Worker Implementation

-   [ ] ASR Worker logic (Req: 1,5,6,7,8,9,10)
    -   [ ] Claim job; transition queued->processing
    -   [ ] Call provider with timeout
    -   [ ] Format artifacts
    -   [ ] Upload artifacts (StorageRepo)
    -   [ ] Insert asr_artifacts rows
    -   [ ] Patch job done (durationSec, detectedLanguage, completedAt)
    -   [ ] Emit metrics/events
    -   [ ] Error path: patch failed (errorCode, errorMessage), events, metrics
    -   [ ] Tests with mock provider success/failure

## 7. External API (Future Flag)

-   [ ] Endpoints (Req: 2,3,4)
    -   [ ] POST /v1/asr/jobs (flag ENABLE_ASR_API)
    -   [ ] GET /v1/asr/jobs/:id
    -   [ ] GET /v1/asr/jobs/:id/results
    -   [ ] OpenAPI schemas additions
    -   [ ] Integration tests

## 8. Metrics & Observability

-   [ ] Metrics (Req: 7,8)
    -   [ ] Register counters/histograms
    -   [ ] Instrument provider call duration & retries
    -   [ ] Add inflight gauge updates
-   [ ] Logging & events (Req: 9)
    -   [ ] Add job_events for ASR transitions
    -   [ ] Redact secrets in error logs

## 9. Cleanup

-   [ ] Extend cleanup logic (Req: 11)
    -   [ ] Include transcript prefixes in deletion
    -   [ ] Expire asr_jobs rows (status done/failed) past retention
    -   [ ] Tests for cleanup idempotency

## 10. Configuration & Env

-   [ ] Document new env vars (Req: 6,7)
    -   [ ] Update README and sample .env (without real keys)
    -   [ ] Add config parsing for ASR_REQUEST_TIMEOUT_MS, ASR_MAX_DURATION_SEC, ASR_JSON_SEGMENTS, ASR_CONCURRENCY, MERGE_GAP_MS
    -   [ ] Tests for config defaults

## 11. Performance & Reliability

-   [ ] Benchmark test (Req: 7)
    -   [ ] Measure formatting time for synthetic 500/1000 segment arrays
-   [ ] Retry/backoff test (Req: 6)
    -   [ ] Simulate 500, 429 with Retry-After

## 12. Security Review

-   [ ] Redaction verification (Req: 9)
    -   [ ] Ensure GROQ_API_KEY never appears in logs
    -   [ ] Test redaction against provider error payloads

## 13. Documentation

-   [ ] Update planning docs cross-links (Req: 1-11)
    -   [ ] Link main requirements subtitle section to ASR doc
-   [ ] Add usage notes for internal vs external ASR jobs

## 14. Future Hooks (Deferred)

-   [ ] Speaker diarization placeholder (deferred)
-   [ ] Real-time streaming pathway (deferred)

---

Milestones:
M1 – Schema + Provider + Formatter (Sections 1-3)
M2 – Facade + Queue + Worker (Sections 4-6)
M3 – External API + Metrics + Cleanup (Sections 7-9)
M4 – Perf, Security, Docs (Sections 10-13)

Risks & Mitigations:

-   Provider rate limits: implement exponential backoff + metrics.
-   Large segment counts: merge algorithm reduces fragmentation.
-   Hash collisions extremely unlikely; still rely on SHA256.
-   Timeout edge: ensure proper abort to release connection.
````

## File: src/worker/index.ts
````typescript
import {
    createLogger,
    readEnv,
    requireEnv,
    fromException,
} from '@clipper/common';
import {
    DrizzleJobsRepo,
    DrizzleJobEventsRepo,
    DrizzleAsrJobsRepo,
    createDb,
    resolveUploadSource,
    resolveYouTubeSource,
    createSupabaseStorageRepo,
    storageKeys,
} from '@clipper/data';
import { PgBossQueueAdapter } from '@clipper/queue';
import { BunClipper } from '@clipper/ffmpeg';
import { AsrFacade } from '@clipper/asr/facade';
export * from './asr.ts';

const log = createLogger((readEnv('LOG_LEVEL') as any) || 'info').with({
    mod: 'worker',
});

const jobs = new DrizzleJobsRepo(createDb());
const events = new DrizzleJobEventsRepo(createDb());
const queue = new PgBossQueueAdapter({
    connectionString: requireEnv('DATABASE_URL'),
});
const clipper = new BunClipper();
const storage = (() => {
    try {
        return createSupabaseStorageRepo();
    } catch (e) {
        log.warn('storage repo init failed (uploads will fail)', {
            error: String(e),
        });
        return null as any;
    }
})();
const asrFacade = new AsrFacade({
    asrJobs: new DrizzleAsrJobsRepo(createDb()),
});

async function main() {
    await queue.start();
    await queue.consume(async ({ jobId }: { jobId: string }) => {
        const startedAt = Date.now();
        const nowIso = () => new Date().toISOString();
        let cleanup: (() => Promise<void>) | null = null;
        let outputLocal: string | null = null;

        const finish = async (status: 'done' | 'failed', patch: any = {}) => {
            await jobs.update(jobId, { status, ...patch });
            await events.add({ jobId, ts: nowIso(), type: status });
        };

        try {
            const job = await jobs.get(jobId);
            if (!job) {
                log.warn('job not found', { jobId });
                return;
            }
            if (job.status === 'done') return; // idempotent
            if (job.status !== 'processing') {
                await jobs.update(jobId, { status: 'processing', progress: 0 });
                await events.add({ jobId, ts: nowIso(), type: 'processing' });
            }

            // Resolve source
            let resolveRes: {
                localPath: string;
                cleanup: () => Promise<void>;
                meta?: any;
            };
            if (job.sourceType === 'upload') {
                resolveRes = await resolveUploadSource({
                    id: job.id,
                    sourceType: 'upload',
                    sourceKey: job.sourceKey!,
                } as any);
            } else {
                try {
                    resolveRes = await resolveYouTubeSource({
                        id: job.id,
                        sourceType: 'youtube',
                        sourceUrl: job.sourceUrl!,
                    } as any);
                } catch (e) {
                    throw new Error('RESOLVE_FAILED');
                }
            }
            cleanup = resolveRes.cleanup;
            await events.add({
                jobId,
                ts: nowIso(),
                type: 'source:ready',
                data: { durationSec: resolveRes.meta?.durationSec },
            });

            // Perform clip
            const { localPath: clipPath, progress$ } = await clipper.clip({
                input: resolveRes.localPath,
                startSec: job.startSec,
                endSec: job.endSec,
                jobId,
            });
            outputLocal = clipPath;
            let lastPersist = 0;
            let lastPct = -1;
            const persist = async (pct: number) => {
                await jobs.update(jobId, { progress: pct });
                await events.add({
                    jobId,
                    ts: nowIso(),
                    type: 'progress',
                    data: { pct, stage: 'clip' },
                });
            };
            const debounceMs = 500;
            for await (const pct of progress$) {
                const now = Date.now();
                if (
                    pct === 100 ||
                    pct >= lastPct + 1 ||
                    now - lastPersist >= debounceMs
                ) {
                    await persist(pct);
                    lastPersist = now;
                    lastPct = pct;
                }
            }
            if (lastPct < 100) await persist(100);

            // Upload result
            if (!storage) throw new Error('STORAGE_NOT_AVAILABLE');
            const key = storageKeys.resultVideo(jobId);
            await storage.upload(clipPath, key, 'video/mp4');
            await events.add({
                jobId,
                ts: nowIso(),
                type: 'uploaded',
                data: { key },
            });

            // If subtitles requested and set to auto, create ASR job request (fire-and-forget)
            if (
                job.withSubtitles &&
                (job.subtitleLang === 'auto' || !job.subtitleLang)
            ) {
                try {
                    const asrRes = await asrFacade.request({
                        localPath: clipPath,
                        clipJobId: job.id,
                        sourceType: 'internal',
                        languageHint: job.subtitleLang ?? 'auto',
                    });
                    await events.add({
                        jobId,
                        ts: nowIso(),
                        type: 'asr:requested',
                        data: {
                            asrJobId: asrRes.asrJobId,
                            status: asrRes.status,
                        },
                    });
                } catch (e) {
                    // don't fail the clip if ASR enqueue fails
                    await events.add({
                        jobId,
                        ts: nowIso(),
                        type: 'asr:error',
                        data: { err: String(e) },
                    });
                }
            }

            await finish('done', { progress: 100, resultVideoKey: key });
            const ms = Date.now() - startedAt;
            log.info('job completed', { jobId, ms });
        } catch (e) {
            const err = fromException(e, jobId);
            log.error('job failed', { jobId, err });
            try {
                await jobs.update(jobId, {
                    status: 'failed',
                    errorCode:
                        (err.error && (err.error as any).code) || 'INTERNAL',
                    errorMessage:
                        (err.error && (err.error as any).message) || String(e),
                });
                await events.add({ jobId, ts: nowIso(), type: 'failed' });
            } catch {}
        } finally {
            // Cleanup source + local output
            if (cleanup) {
                try {
                    await cleanup();
                } catch {}
            }
            if (outputLocal) {
                try {
                    await Bun.spawn(['rm', '-f', outputLocal]).exited;
                } catch {}
            }
        }
    });
}

if (import.meta.main) {
    const run = async () => {
        try {
            await main();
        } catch (e) {
            log.error('worker crashed', { err: String(e) });
            process.exit(1);
        }
    };
    const stop = async () => {
        log.info('worker stopping');
        await queue.shutdown();
        process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    run();
}
````
