---
artifact_id: 6b0c134f-9f3e-4bc5-98bd-6dac85672a67
name: Subtitle burning enablement - tasks
version: 1.0
owner: platform-video
status: draft
---

# tasks.md

## 0. Pre-checks

-   [ ] Verify ffmpeg present on worker containers/hosts.
-   [ ] Confirm Supabase storage configuration in env.

## 1. Database and types

-   [ ] Add column `result_video_burned_key text` to jobs table (drizzle migration).
    -   Requirements: 2.2, 3.1, 8.1
-   [ ] Update `src/data/db/schema.ts` and `repos.ts` to map `resultVideoBurnedKey`.
    -   Requirements: 2.2, 3.1, 8.1
-   [ ] Update contracts/types so API can include optional `burnedVideo` in responses.
    -   Requirements: 3.1

## 2. API validation and responses

-   [ ] POST /api/jobs: if burnSubtitles=true and withSubtitles=false, reject with 400 VALIDATION_FAILED or coerce (decide: reject).
    -   Requirements: 7.1
-   [ ] GET /api/jobs/:id and /api/jobs/:id/result: include `resultVideoBurnedKey` and return `burnedVideo` URL if present.
    -   Requirements: 2.2, 3.1
-   [ ] Update API docs under docs/guide.md and docs/api-reference.md with new burnedVideo field.
    -   Requirements: 10.3

## 3. ASR worker: burn-in pipeline

-   [ ] Add safe path escaping utility for subtitles filter.
    -   Requirements: 7.2
-   [ ] Add burn-in function using ffmpeg with style defaults; parse exit code/stderr.
    -   Requirements: 2.1, 4.1, 4.2
-   [ ] Emit metrics `burnin.started`, `burnin.completed`, `burnin.failed`, `burnin.duration_ms`.
    -   Requirements: 6.1
-   [ ] Emit job events `burnin:*` around operation.
    -   Requirements: 6.2
-   [ ] Upload burned video to `storageKeys.resultVideoBurned(jobId)` and persist `resultVideoBurnedKey` (do not overwrite original resultVideoKey).
    -   Requirements: 2.2, 8.1

## 4. Cleanup and retention

-   [ ] Ensure cleanup job removes `result_video_burned_key` artifact.
    -   Requirements: 8.2

## 5. Tests

-   [ ] Unit tests: escaping util, API validation, repo mapping for burned key, metrics/events emission (mocked).
    -   Requirements: 10.1
-   [ ] Integration test: synthesize short video, mock ASR segments -> buildArtifacts -> write SRT -> burn-in -> assert burned asset exists; guarded by ffmpeg availability.
    -   Requirements: 10.2
-   [ ] E2E (optional): Run worker end-to-end behind env guards in CI.

## 6. Backfill tool (admin)

-   [ ] Add an admin-only endpoint or CLI script to run burn-in for an existing job id (requires resultVideoKey + resultSrtKey present).
    -   Requirements: 9.1

## 7. Documentation

-   [ ] Expand docs/guide.md section 7 with concrete flags and response examples.
    -   Requirements: 10.3
-   [ ] Document performance expectations and troubleshooting in docs/ffmpeg.md.
    -   Requirements: 5.1, 10.3

## Mapping to Requirements

-   1.x → Section 2 (ASR queue already), 3 (ASR worker uploads), API result includes srt
-   2.x → Sections 1–4
-   3.x → Sections 1–2
-   4.x → Section 3
-   5.x → Section 7 (docs) + performance note in design
-   6.x → Section 3 metrics/events
-   7.x → Section 2 validation + 3 escaping
-   8.x → Section 1/4 storage+cleanup
-   9.x → Section 6 backfill
-   10.x → Sections 5 and 7
