# FFmpeg Clipper Deep Dive

## Goals

Fast, reliable sub-clipping of source media while:

-   Minimizing transcode time (attempt stream copy)
-   Guaranteeing playable output (fallback re-encode)
-   Streaming progress for real-time UX
-   Avoiding unbounded disk growth / memory overhead

## Design Summary

1. Validate input (start < end, duration > 0, within configured max, size guardrails)
2. Resolve local source path (already normalized by Media IO layer)
3. Attempt Copy Mode:
   ffmpeg -hide_banner -nostdin -ss <start> -to <end> -i <in> -c copy -movflags +faststart <out>
4. If non‑zero exit → Attempt Re-encode Mode:
   ffmpeg -hide_banner -nostdin -ss <start> -to <end> -i <in> -c:v libx264 -preset veryfast -profile:v main -level 4.1 -c:a aac -movflags +faststart -pix_fmt yuv420p <out>
5. Parse progress from `-progress pipe:1` stream (key=value pairs, `out_time_ms=`) → percent (0..99). Upon process exit (code 0) emit 100.
6. Debounce persistence (>=1% change OR 500ms elapsed OR final 100%).
7. Upload artifact.
8. Emit final job completion (future: attach performance metrics, source metadata, waveform, subtitles).

## Verification Gate (OutputVerifier)

Every produced output is validated before upload using a strict verifier:

-   Duration within tolerance of target segment
-   Presence of required streams (video or audio)
-   For MP4/MOV: faststart (moov before mdat) is required
-   For re-encoded outputs: codec allowlists (video=h264, audio=aac)

Behavior by path:

-   Copy success → verify with tolerance 1.0s → on failure, the file is deleted and we fallback to re-encode
-   Re-encode success → verify with tolerance 0.5s plus codec allowlists → on failure, delete and surface OUTPUT_VERIFICATION_FAILED

Related env flags (defaults in parentheses):

-   VERIFY_TOLERANCE_SEC (0.5) — base tolerance; copy path passes 1.0 explicitly
-   VERIFY_REQUIRE_FASTSTART (true) — require +faststart for MP4/MOV

Failure code surfaced to API (via worker): `OUTPUT_VERIFICATION_FAILED` (HTTP 422)

## Progress Parsing

FFmpeg with `-progress pipe:1 -nostats` yields lines like:

```
frame=23
out_time_ms=1234567
speed=1.5x
progress=continue
```

We track only `out_time_ms` relative to target clip duration. A cap of 99% prevents premature 100% before process exit. On exit with code 0 we emit a final 100% event.

Edge cases handled:

-   Zero or near-zero target duration (emit 100 immediately)
-   Non-monotonic or duplicated `out_time_ms` (ignored if lower than previous)
-   Duration overrun (clamped to 99)

## Keyframe Guardrails (Copy Decision)

Stream copy is only attempted when keyframes are near the requested start if enabled:

-   REQUIRE_KEYFRAME_FOR_COPY (false) — when true, copy path runs only if a keyframe is close to start
-   KEYFRAME_PROXIMITY_SEC (0.5) — maximum allowed keyframe distance from start

Mechanics: we ask ffprobe to scan keyframes near the requested start using `-read_intervals <start>%+#2` and compute the first keyframe timestamp ahead of the start. If the delta exceeds the proximity window, we skip copy and go straight to re-encode for accuracy.

## Error Strategy

-   Copy attempt failure automatically triggers fallback (no user-visible error)
-   Re-encode failure (or verification failure) surfaces a structured ServiceError which maps to API error envelopes.
    -   Verification failure → `OUTPUT_VERIFICATION_FAILED`
    -   Source unreadable at probe → `SOURCE_UNREADABLE`
    -   Both attempts fail (rare) → `BAD_REQUEST` with an ffmpeg exit summary
    -   The API maps failures to stable HTTP codes: 422/503/etc.
    -   Stderr is truncated to avoid bloating logs.

## Concurrency & Temp Files

Each job gets an isolated scratch subdirectory: `${SCRATCH_DIR}/jobs/<jobId>/`. Temp output uses `<jobId>-work.mp4` then final artifact key is `results/{jobId}/clip.mp4` in storage. Cleanup step removes scratch dir post-success (or leaves for inspection on failure, configurable in future via KEEP_FAILED=1).

## Potential Improvements

-   Smarter keyframe alignment heuristics (pre-checked via ffprobe already; could expand window/backtracking)
-   Waveform generation (`-filter_complex astats|showwavespic`) for preview thumbnails
-   Thumbnail sprite extraction
-   Subtitle burn-in option (if SRT present)
-   Multi-resolution output set (1080p, 720p) -> HLS packaging
-   GPU accelerated fallback (VAAPI / NVENC) when available

## Testing Strategy

-   Integration test ensures a small sample clip completes with 100%
-   Fallback test forces copy failure by mocking spawn exit code
-   Validation tests exercise boundary errors
-   Progress unit tests feed synthetic progress stream

## Observability TODOs

-   Stage timers recorded via worker.stage_latency_ms{stage}
-   External call timings via external.call_latency_ms{service,op}
-   Clip totals and upload timings via clip.total_ms and clip.upload_ms

## Security Considerations

-   No untrusted arguments are interpolated unsafely; times are numeric validated
-   Future: sandbox environment / seccomp profile when executing ffmpeg for defense in depth

---

Last updated: 2025-08-15
