---
artifact_id: 1f6f3c64-1b0e-4d8a-9a5b-1a3bf7c5c36e
name: Subtitle burning enablement
version: 1.0
owner: platform-video
status: draft
---

# requirements.md

## Introduction

Enable end-to-end subtitle burning for generated clips. Users can request automatic ASR, receive an SRT artifact, and optionally get a second "burned-in" MP4 where subtitles are rendered into the video frames. The system must integrate with existing job lifecycle, storage layout, and API without breaking current flows. It should support safe defaults, clear errors, and remain resilient in worker restarts.

## Requirements

1. User requests subtitles

    - User Story: As a client, I want to request subtitles for my clip, so that I can download an SRT.
    - Acceptance Criteria:
        - WHEN a job is created with withSubtitles=true THEN the system SHALL enqueue an ASR job for the clip upon clip completion.
        - WHEN ASR completes THEN the system SHALL persist an SRT at results/{jobId}/clip.srt and expose resultSrtKey in the job payloads.
        - IF ASR fails THEN the parent job SHALL remain done for the video but resultSrtKey SHALL be absent and an event SHALL be recorded (non-fatal).

2. User requests burned-in subtitles

    - User Story: As a client, I want an option to receive a burned-in MP4, so that captions appear directly on the video.
    - Acceptance Criteria:
        - WHEN a job is created with burnSubtitles=true AND withSubtitles=true THEN the system SHALL produce an additional burned MP4 at results/{jobId}/clip.subbed.mp4.
        - WHEN burn-in succeeds THEN the API result endpoint SHALL prefer the burned MP4 if present OR include both original and burned URLs as distinct fields.
        - IF burn-in fails THEN the system SHALL keep the original MP4; failure SHALL be logged and surfaced as a non-fatal event without breaking job completion.

3. API surface and schema compatibility

    - User Story: As an integrator, I want a stable API shape with optional fields for subtitles and burned video, so that clients can adopt gradually.
    - Acceptance Criteria:
        - WHEN fetching /api/jobs/:id and /api/jobs/:id/result THEN responses SHALL include optional srt and optional burnedVideo fields (key + signed url) when available.
        - Existing fields SHALL remain unchanged; no breaking changes to current clients.

4. Format support and correctness

    - User Story: As a user, I want burned-in subtitles to render reliably across environments, so that text is readable and synchronized.
    - Acceptance Criteria:
        - The burn-in pipeline SHALL accept SRT input. VTT MAY be supported later.
        - Default font size, safe margins, outline, and background SHALL be legible (e.g., ASS style via force_style).
        - Timing SHALL match the SRT timestamps within ±100ms.

5. Performance and resource usage

    - User Story: As an operator, I need burning not to degrade overall throughput.
    - Acceptance Criteria:
        - Burn-in SHALL run after the main MP4 is ready and MAY reuse it as input; it SHALL not block the main job from completing if optional.
        - Average burn-in time for a 60s clip on typical CPU SHALL be under 2x the re-encode path for that clip. Document expectations and provide metrics.

6. Observability and metrics

    - User Story: As an operator, I need visibility into ASR and burn-in outcomes.
    - Acceptance Criteria:
        - The worker SHALL emit metrics for asr.completed, asr.failures, burnin.started, burnin.completed, burnin.failed, and durations.
        - Events SHALL be appended to the job timeline for ASR requested/completed and burn-in started/completed/failed.

7. Security and validation

    - User Story: As a platform owner, I want input validation and safe defaults.
    - Acceptance Criteria:
        - The API SHALL validate cross-field logic: burnSubtitles implies withSubtitles.
        - The worker SHALL sanitize subtitle file paths in the ffmpeg filter (escape quotes/spaces) to prevent filtergraph injection.

8. Storage and retention

    - User Story: As an operator, I want consistent storage keys and cleanup.
    - Acceptance Criteria:
        - Artifacts SHALL be stored under results/{jobId}/ as currently defined by storageKeys.
        - Cleanup job SHALL remove burned video and SRT alongside the primary clip after expiration.

9. Backfill and compatibility

    - User Story: As an existing user, I want to request burning on already-completed clips with SRT.
    - Acceptance Criteria:
        - Provide an internal admin-only endpoint or CLI to trigger burn-in for an existing job that already has resultVideoKey and resultSrtKey.

10. Testing and documentation

-   User Story: As a developer, I want confidence and clear docs.
-   Acceptance Criteria:
    -   Unit tests SHALL cover API validation, worker burn-in invocation, and error handling.
    -   Integration test SHALL perform a small end-to-end burn on a generated test clip (guards for CI environment with ffmpeg available).
    -   Docs SHALL add a section describing how to request subtitles and burned-in output, including limits and caveats.
