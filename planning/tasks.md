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
    -   [ ] Add minimal client for Groq Whisper; convert to SRT
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
