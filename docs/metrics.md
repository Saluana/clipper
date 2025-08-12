# Metrics Reference

Endpoint: `GET /metrics` returns a JSON snapshot (simple counters + observed distributions). Names below indicate intent.

## Job Lifecycle

-   jobs.created (counter) — Number of clip jobs created.
-   jobs.enqueue_latency_ms (histogram/summary) — Latency from job creation to queue publish.
-   jobs.status_fetch (counter) — Status endpoint hits.
-   jobs.result_fetch (counter) — Result endpoint hits.

## Cleanup

-   cleanup.jobs.deleted (counter) — Expired clip jobs removed.
-   cleanup.asrJobs.deleted (counter) — Expired ASR jobs removed.

## Media IO (Download / Probe / Resolve)

-   mediaio.download.bytes (counter) — Bytes streamed for uploaded media (labels include maybe source/type).
-   mediaio.ytdlp.duration_ms (histogram) — Time spent running yt-dlp.
-   mediaio.ffprobe.duration_ms (histogram) — Time spent running ffprobe.
-   mediaio.resolve.duration_ms (histogram) — End-to-end resolve (download + probe) time.

## Repository (Database) Operations

-   repo.op.duration_ms (histogram) — Duration of repository operations; has label `op` (e.g., jobs.create, jobs.get, asrJobs.create, asrArtifacts.put)

## Clip Worker

-   clip.upload_ms (histogram) — Time to upload generated clip to storage.
-   clip.total_ms (histogram) — Overall clip processing duration.
-   clip.failures (counter) — Clip processing failures.

## ASR Pipeline

-   asr.duration_ms (histogram) — Time for ASR transcription per job.
-   asr.completed (counter) — Successful ASR jobs.
-   asr.failures (counter) — Failed ASR jobs.

## Queue

-   (From /metrics/queue) Implementation-specific fields (depth, active, etc.) produced by PgBoss adapter.

## Usage Guidance

Counters monotonically increase until process restart. Histograms/observations are aggregated in-memory; scrape interval should be frequent (`15s-60s`) for real-time dashboards.

## Adding New Metrics

Follow naming: `<domain>.<action>[_<unit>]` with `_ms` for millisecond durations, plural nouns for counts (e.g., `jobs.created`). Keep domain sets small & stable.
