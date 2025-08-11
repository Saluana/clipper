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
