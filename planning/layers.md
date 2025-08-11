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

FFmpeg Service (Clipper)
ASR Service (Groq Whisper)
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
