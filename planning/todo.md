# Project Completion TODO (Focused & Prioritized)

Only incomplete planned items from layers doc; excludes new/optional stretch features. Order chosen by dependency + fastest user value.

## 1. Schema & Groundwork (must precede dependent code)

-   [x] Drizzle migration scripts committed + README command (db:migrate documented)
-   [x] Migration: unique partial index (media_hash, model_version) WHERE status='done' (in 0001_asr_jobs.sql)
-   [x] Add last_heartbeat_at column (0002_add_last_heartbeat.sql)
-   [x] Backfill expiresAt for existing rows (script backfill-expires.ts)

## 2. Core API Completion (unblocks external consumption)

-   [x] GET /api/jobs/:id (status, progress, result keys, recent events)
-   [x] GET /api/jobs/:id/result (signed clip URL; 404 missing, 410 expired)
-   [x] Consistent error envelope (code,message,correlationId)

## 3. Storage & Delivery (required by result endpoint reliability)

-   [x] Signed URL integration in result endpoint
-   [x] Retry transient storage upload failures (limited backoff)

## 4. Reliability Hardening (stabilize before ASR load)

-   [x] Worker heartbeat writes (last_heartbeat_at updates)
-   [x] Global clip timeout enforcement

## 5. ASR Pipeline (major missing functional layer)

-   [x] ASR queue consumer: extract audio (-vn -ac 1 -ar 16k), call provider, build SRT/text/(json), upload, insert asr_artifacts, update asr_jobs
-   [x] Provider error mapping (TIMEOUT, UPSTREAM_FAILURE, VALIDATION_FAILED)
-   [x] Update originating clip job.resultSrtKey on ASR completion
-   [x] Persist resultSrtKey when ASR finishes
-   [x] Burn-in subtitles when job.burnSubtitles=true

## 6. Observability (instrument after ASR path exists)

-   [ ] /metrics endpoint: job duration histogram, queue depth, ffmpeg fallback counter, ASR latency & status counts, storage upload latency
-   [ ] Add jobId/asrJobId correlation fields consistently in logs

## 7. Cleanup (after ASR artifacts introduced)

-   [ ] Extend cleanup to remove expired ASR jobs + transcript artifacts

## 8. Security & Abuse Controls

-   [ ] API key auth (lookup hash)
-   [ ] Basic rate limiting for job creation (per key/IP)
-   [ ] Document existing SSRF allowlist behavior

## 9. Docs

-   [ ] API reference markdown (create/status/result) with curl examples
-   [ ] Brief metrics reference (names + purpose)

## 10. Tests (add alongside each feature)

-   [ ] API tests: create -> status -> result flow
-   [ ] ASR worker integration test (mock provider) verifying SRT artifact + job update
-   [ ] Cleanup test including ASR artifact deletion
-   [ ] Security tests: auth required (if enabled), rate limit enforcement
-   [ ] Metrics endpoint test (basic scrape contains expected metric names)

---

Execution guidance: Finish 1–4 first, ship; then implement 5 with feature flag, immediately add 6 & 7, follow with 8–10.
