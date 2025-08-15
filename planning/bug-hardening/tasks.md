# Robustness & Bug Hardening Tasks

artifact_id: 6c8db0e8-2db6-4c4c-8e6e-3a4c7e4f9d5e

## 1. Validation & Config

-   [x] 1.1 Add env flags with defaults in `src/common/env.ts` (Req 1,10)
-   [x] 1.2 Strengthen API zod validation for start/end and max duration (Req 1)
-   [x] 1.3 Implement optional coercion in request handling or worker (Req 1)
-   [x] 1.4 Unit tests for validation/coercion (Req 1)

## 2. Probe Layer

-   [x] 2.1 Implement `Prober` using ffprobe in `src/ffmpeg/probe.ts` (Req 2)
-   [x] 2.2 Integrate probe before processing; fail fast on unreadable (Req 2)
-   [x] 2.3 Unit tests with mocked ffprobe output (Req 2)

## 3. Copy Decision Guardrails

-   [x] 3.1 Add `shouldAttemptCopy` utility + feature flag (Req 3)
-   [x] 3.2 Integrate into `clipper.ts` path selection (Req 3)
-   [x] 3.3 Unit tests for decision logic (Req 3)

## 4. Output Verification

-   [x] 4.1 Implement `OutputVerifier` in `src/ffmpeg/verify.ts` (Req 4)
-   [x] 4.2 Wire verification after copy and encode, before upload (Req 4)
-   [x] 4.3 Delete invalid outputs and surface OUTPUT_VERIFICATION_FAILED (Req 4,7,8)
-   [x] 4.4 Unit tests with fixtures (Req 4)

## 5. Progress Semantics

-   [ ] 5.1 Ensure progress parser caps at 99% until exit and emits final 100% (Req 5)
-   [ ] 5.2 Near-zero duration fast-path to 100% (Req 5)
-   [ ] 5.3 Unit tests for progress logic (Req 5)

## 6. Retry Classification

-   [ ] 6.1 Implement `classifyError` and wire into worker retry policy (Req 6)
-   [ ] 6.2 Respect MAX_RETRIES and backoff; mark RETRY_EXHAUSTED (Req 6)
-   [ ] 6.3 Unit tests for classification (Req 6)

## 7. Cleanup Consistency

-   [ ] 7.1 Centralize cleanup helpers; honor KEEP_FAILED (Req 7)
-   [ ] 7.2 Ensure partial storage uploads are removed on failure (Req 7)
-   [ ] 7.3 Integration test for cleanup after verification failure (Req 7)

## 8. Error Envelope & Codes

-   [ ] 8.1 Ensure API maps worker errors to stable codes and envelopes (Req 8)
-   [ ] 8.2 Add tests verifying error shapes (Req 8)

## 9. Metrics & Observability

-   [ ] 9.1 Add counters/histograms as specified (Req 9)
-   [ ] 9.2 Update docs/metrics.md with new series (Req 9,10)
-   [ ] 9.3 Dashboards/alerts placeholders (optional) (Req 9)

## 10. Documentation

-   [ ] 10.1 Update docs/ffmpeg.md: verification, keyframe guardrails, flags (Req 10)
-   [ ] 10.2 Update docs/guide.md: near-zero handling and errors (Req 10)

## Mapping to Requirements

-   1.x → Req 1,10
-   2.x → Req 2
-   3.x → Req 3
-   4.x → Req 4,7,8
-   5.x → Req 5
-   6.x → Req 6
-   7.x → Req 7
-   8.x → Req 8
-   9.x → Req 9
-   10.x → Req 10
