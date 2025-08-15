# Robustness & Bug Hardening Requirements

artifact_id: 8b6f9f7c-6a56-4a2f-9d7d-3e7c4f8b7b2d

## Introduction

Harden the clipper pipeline against edge cases the current try/catch fallbacks don’t fully cover. Focus areas: zero/near-zero durations, time-boundary validation, output integrity verification (container/codecs/duration), retry classification, cleanup consistency, and uniform error envelopes and metrics.

## Roles

-   API Client – submits jobs and reads results
-   Worker – executes ffmpeg, uploads artifacts
-   Operator – monitors failures and performance

## Functional Requirements

1. Time Validation and Coercion

-   Story: As a client, I want invalid or ambiguous time ranges to be rejected early.
-   Acceptance:
    -   WHEN start >= end THEN the API SHALL return 400 with code VALIDATION_FAILED and no job is enqueued.
    -   WHEN (end - start) < MIN_DURATION_SEC (configurable; default 0.5s) THEN the system SHALL treat it as near-zero and either (a) coerce to MIN_DURATION_SEC if COERCE_MIN_DURATION=true or (b) reject with 400; the behavior SHALL be documented and logged.
    -   WHEN requested duration > MAX_CLIP_DURATION_SEC THEN the API SHALL return 400 with code DURATION_TOO_LONG.

2. Source Probing Preconditions

-   Story: As an operator, I want early detection of unusable sources.
-   Acceptance:
    -   IF ffprobe cannot parse streams or discover duration THEN the job SHALL fail fast with code SOURCE_UNREADABLE.
    -   The system SHALL record probed fields: container, video/audio stream presence, durationSec, startTimeSec.

3. Copy vs Re-encode Decision Guardrails

-   Story: As a client, I want copy mode to be attempted only when safe.
-   Acceptance:
    -   IF start is not near a keyframe AND REQUIRE_KEYFRAME_FOR_COPY=true THEN the system SHALL skip copy mode and go directly to re-encode.
    -   IF copy attempt exits non-zero THEN the system SHALL attempt re-encode once and classify the error.

4. Output Integrity Verification

-   Story: As a client, I want only playable outputs to be returned.
-   Acceptance:
    -   AFTER ffmpeg success, the system SHALL verify: file exists, size > 0, faststart moov present (for MP4), at least one video or audio stream as requested, duration within ± TOLERANCE_SEC of requested, and codecs are in the allowed set for fallback (e.g., h264/aac for MP4).
    -   IF verification fails THEN the job SHALL be marked failed with code OUTPUT_VERIFICATION_FAILED; partial artifact SHALL be deleted from storage and scratch.

5. Progress and Terminal Events Accuracy

-   Story: As a client, I want accurate progress and terminal state.
-   Acceptance:
    -   Progress SHALL be monotonic and capped at 99% until the process exits 0, at which time a final 100% SHALL be emitted.
    -   For near-zero durations (< MIN_DURATION_SEC), the system SHALL emit a single 100% progress event promptly.

6. Retry Classification and Limits

-   Story: As an operator, I want retries only for transient failures.
-   Acceptance:
    -   Errors SHALL be classified as RETRYABLE (e.g., EPIPE, ENOSPC transient storage, 5xx provider) or NON_RETRYABLE (validation, verification, unsupported codec).
    -   The worker SHALL not exceed MAX_RETRIES with exponential backoff; after exhaustion the job SHALL be marked failed with code RETRY_EXHAUSTED.

7. Cleanup Consistency

-   Story: As an operator, I want no orphaned scratch files or partial uploads.
-   Acceptance:
    -   On success, the worker SHALL delete scratch directories.
    -   On failure, the worker SHALL delete scratch outputs and any partially uploaded storage objects, unless KEEP_FAILED=1.

8. Error Envelope Uniformity

-   Story: As a client, I want consistent error shapes.
-   Acceptance:
    -   ALL non-2xx responses SHALL include { error: { code, message, correlationId } } and optional details[].
    -   Worker errors surfaced via API SHALL map to stable codes (e.g., SOURCE_UNREADABLE, FFMPEG_COPY_FAILED, FFMPEG_REENCODE_FAILED, OUTPUT_VERIFICATION_FAILED).

9. Metrics and Alerts

-   Story: As an operator, I want to observe failures and performance.
-   Acceptance:
    -   The system SHALL emit counters: clips.started, clips.completed, clips.failed{reason}, copy.attempted, copy.fell_back, verify.failed{kind}.
    -   The system SHALL emit histograms: clip.duration.requested_sec, ffmpeg.run_ms, verify.ms.

10. Configurability and Docs

-   Story: As a maintainer, I want safe defaults and clear flags.
-   Acceptance:
    -   Feature toggles and thresholds (MIN_DURATION_SEC, TOLERANCE_SEC, REQUIRE_KEYFRAME_FOR_COPY) SHALL be configurable via env with documented defaults.
    -   Documentation SHALL describe behaviors and trade-offs.

## Non-Functional Requirements

-   Performance: Additional probe/verify steps SHALL add <150ms median overhead for small clips on local FS.
-   Security: No unsafe argument interpolation; path escaping for filters; verification SHALL not leak sensitive paths in errors.
-   Backward compatibility: Defaults mirror existing behaviors unless explicitly changed via flags.
