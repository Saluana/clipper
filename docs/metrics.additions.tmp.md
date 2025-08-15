## Worker Stages (Req 4)

-   worker.stage_latency_ms{stage} (histogram) — Duration for stages: resolve, clip, upload, asr.
-   worker.stage_failures_total{stage,code} (counter) — Classified stage failures (timeout|not_found|network|error...).

## External Dependencies (Req 5)

-   external.calls_total{service,op,outcome[,code]} (counter) — Upstream call attempts (service: yt_dlp|ffprobe|storage|asr; outcome: ok|err; code on error: timeout|not_found|auth|network|too_large|error|custom).
-   external.call_latency_ms{service,op} (histogram) — Duration per external operation.

## Worker Gauges

-   worker.inflight_jobs (gauge) — Current number of active jobs being processed by this worker instance.

## Process & Runtime (Req 6)

-   proc.memory_rss_mb (gauge) — Resident memory in MB.
-   proc.open_fds (gauge) — Open file descriptor count (best-effort; -1 if unavailable).
-   scratch.disk_used_pct (gauge) — % usage of scratch directory (or -1 if unknown).
-   event_loop.lag_ms (histogram) — Event loop delay; measures scheduling latency of the sampler.
