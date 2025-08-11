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

## Error Strategy

Copy attempt failure automatically triggers fallback. Re-encode failure surfaces a structured ServiceError (consider specialized code FFMPEG_FAILED). Stderr is truncated (first N lines) to avoid bloating logs.

## Concurrency & Temp Files

Each job gets an isolated scratch subdirectory: `${SCRATCH_DIR}/jobs/<jobId>/`. Temp output uses `<jobId>-work.mp4` then final artifact key is `results/{jobId}/clip.mp4` in storage. Cleanup step removes scratch dir post-success (or leaves for inspection on failure, configurable in future via KEEP_FAILED=1).

## Potential Improvements

-   Smart keyframe alignment: probe first keyframe after start to decide copy viability before running attempt
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

-   Emit timing metrics: copy_attempt_ms, transcode_attempt_ms
-   Record whether fallback was required (boolean) for optimization insights
-   Count errors by failure phase (copy vs reencode)

## Security Considerations

-   No untrusted arguments are interpolated unsafely; times are numeric validated
-   Future: sandbox environment / seccomp profile when executing ffmpeg for defense in depth

---

Last updated: (add date when editing)
