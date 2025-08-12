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

-   [ ] Define provider interfaces/types (Req: 5,6)
    -   [ ] Add `src/asr/provider.ts` with AsrProvider, segment/result types
    -   [ ] Add error class ProviderHttpError
-   [ ] GroqWhisperProvider (Req: 6,7)
    -   [ ] Implement multipart POST per docs with timeout & abort
    -   [ ] Map verbose_json to segments
    -   [ ] Retry wrapper (exponential backoff, max 3) for 5xx/429/network
    -   [ ] Unit tests (mock fetch)

## 3. Formatting & Artifacts

-   [ ] TranscriptFormatter (Req: 5)
    -   [ ] Implement merge & SRT generation logic
    -   [ ] Implement plain text and optional JSON builder
    -   [ ] Unit tests for gap merge, timestamp rounding, control char stripping
-   [ ] Artifact builder integration (Req: 5,10)
    -   [ ] Function buildArtifacts returning { srt, text, json? }

## 4. Facade & Caching

-   [ ] ASR Facade (Req: 1,5,10)
    -   [ ] Implement request() computing mediaHash (SHA256 stream)
    -   [ ] Reuse existing completed job via getReusable
    -   [ ] Create new asr_job row; enqueue message
    -   [ ] Update worker clipping pipeline to call facade when subtitleLang=auto
    -   [ ] Tests: reuse path vs new path

## 5. Queue Integration

-   [ ] Queue topic (Req: 1,3)
    -   [ ] Add ASR queue name constant (e.g., 'asr') in `src/queue/types.ts`
    -   [ ] Extend pgboss adapter subscribe for ASR job handler
-   [ ] Message shape & validation (Req: 1)
    -   [ ] Define zod schema for ASR queue payload
    -   [ ] Tests for invalid payload rejection

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
