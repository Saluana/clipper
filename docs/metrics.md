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

## Event Persistence

-   events.persist_failures_total (counter) — Number of failed attempts to persist job events (foreign key violations, DB errors).

## Health Endpoint Fields (GET /healthz)

-   ok (boolean) — Composite readiness (queue.ok && db.ok)
-   queue.ok (boolean) — Queue adapter health
-   queue.error (string?) — Present when queue.ok is false
-   db.ok (boolean) — Database ping success flag
-   db.ping_ms (number) — Measured latency of lightweight DB call

## SLOs & Example Queries

### Proposed SLOs

1. API Availability: 99.5% of requests succeed (non-5xx) over 30d.
2. Job Completion Latency: 95% of clip jobs finish (queued -> done) within 5 minutes.
3. ASR Success Rate: 99% of ASR jobs succeed (no failure) over 7d.
4. Event Persistence Reliability: 99.99% of job events persist (failure rate < 0.01%).
5. External Dependency Budget: < 2% of external operations (yt-dlp, ffprobe, storage, asr) fail.

### Derived Metrics (PromQL-style Pseudocode)

Assume counters are exposed to a Prometheus scraper via future adapter (Task 15.1). Replace `rate` windows as desired.

-   Availability: 1 - (sum(rate(http.errors_total{code=~"5.."}[5m])) / sum(rate(http.requests_total[5m])))
-   Job Completion Latency (burn alert): histogram_quantile(0.95, sum(rate(jobs.total_latency_ms_bucket[5m])) by (le)) < 300000
-   ASR Success Rate: sum(rate(asr.completed[5m])) / (sum(rate(asr.completed[5m])) + sum(rate(asr.failures[5m])))
-   Event Persistence Failure Ratio: sum(rate(events.persist_failures_total[5m])) / sum(rate(events.persist_failures_total[5m]) + 1) (Alert when > 0.0001)
-   External Failure Ratio: sum(rate(external.failures_total[5m])) / sum(rate(external.calls_total[5m])) (Naming illustrative; actual labels depend on wrapper implementation)

### Burn Rate Alert Examples (Pseudo)

-   Fast burn (15m): availability_error_ratio > (1 - 0.995) \* 14
-   Slow burn (6h): availability_error_ratio > (1 - 0.995) \* 6

Where availability_error_ratio = sum(rate(http.errors_total{code=~"5.."}[window])) / sum(rate(http.requests_total[window]))

### Troubleshooting Pointers

-   Elevated http.request_latency_ms on a single route + increase in external.\* duration: investigate downstream service.
-   Rising events.persist_failures_total: check DB connectivity, FK integrity; may indicate race where job row not yet committed.
-   Spike in clip.failures with stable external metrics: likely ffmpeg local issue or invalid input parameters.

## Adding New Metrics

Follow naming: `<domain>.<action>[_<unit>]` with `_ms` for millisecond durations, plural nouns for counts (e.g., `jobs.created`). Keep domain sets small & stable.
