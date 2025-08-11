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
