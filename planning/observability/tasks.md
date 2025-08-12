# Observability Improvements Tasks

artifact_id: 8f5b7a3c-9d8a-4c1f-b2f9-3e6d2c1a7b90

## Legend

-   Req refs: Observability Requirements section numbers

## 1. Metric Registry & Core Instruments

-   [x] 1.1 Implement MetricsRegistry (counters, histograms fixed buckets, gauges) (Req 1)
-   [x] 1.2 Add route normalization helper (/:id replacement) (Req 1)
-   [x] 1.3 Unit tests: registry reuse, label limit enforcement (Req 1)

## 2. HTTP Instrumentation

-   [x] 2.1 Middleware wrap request lifecycle (start/end) (Req 2)
-   [x] 2.2 Expose status code class label (2xx/4xx/5xx) (Req 2)
-   [x] 2.3 Error path increments http.errors_total (Req 2)
-   [x] 2.4 Integration test for GET /healthz + 404 path metrics (Req 2)

## 3. Job Lifecycle Metrics

-   [x] 3.1 Hook job creation path -> jobs.created_total (Req 3)
-   [x] 3.2 Hook status transitions -> jobs.status_transition_total (Req 3)
-   [x] 3.3 Observe total latency at done/failed -> jobs.total_latency_ms (Req 3)
-   [x] 3.4 Queue metrics merge into /metrics snapshot (Req 3)

## 4. Worker Stage Timings

-   [x] 4.1 Implement withStage wrapper (Req 4)
-   [x] 4.2 Instrument stages: resolve, clip, upload, asr (Req 4)
-   [x] 4.3 Stage failure counter (Req 4)
-   [x] 4.4 Unit tests simulate stage error classification (Req 4)

## 5. External Dependency Wrappers

-   [x] 5.1 Wrap yt-dlp invocation (Req 5)
-   [x] 5.2 Wrap ffprobe (Req 5)
-   [x] 5.3 Wrap storage signed URL & upload operations (Req 5)
-   [x] 5.4 Wrap ASR provider call (Req 5)

## 6. Resource Sampler

-   [x] 6.1 Implement sampler loop (Req 6)
-   [x] 6.2 Collect RSS, event loop lag (Req 6)
-   [x] 6.3 Collect scratch usage (Req 6)
-   [x] 6.4 Gauge updates + tests (mock fs) (Req 6)

## 7. Structured Logging Enhancements

-   [x] 7.1 Ensure correlationId middleware early (Req 7)
-   [x] 7.2 Include correlationId in job events/logs (Req 7)
-   [x] 7.3 Add redaction pass for log field serialization (Req 7)

## 8. Event Persistence Reliability

-   [x] 8.1 Add metric events.persist_failures_total (Req 8)
-   [x] 8.2 Test DB failure path increments metric (Req 8)

## 9. Health & Readiness Expansion

-   [x] 9.1 Extend /healthz with queue status & db ping ms (Req 9)
-   [x] 9.2 Failure path returns ok:false (Req 9)

## 10. SLO Documentation & Burn Rate Queries

-   [x] 10.1 Document SLOs in docs/metrics.md (Req 10)
-   [x] 10.2 Provide example PromQL or pseudo queries (Req 10)

## 11. Metrics Endpoint Performance

-   [ ] 11.1 Benchmark /metrics under load (Req 11)
-   [ ] 11.2 Optimize snapshot serialization (Req 11)

## 12. Tracing Hooks

-   [ ] 12.1 Define tracer interface (Req 12)
-   [ ] 12.2 No-op implementation + usage in critical paths (Req 12)

## 13. Documentation & Examples

-   [ ] 13.1 Update docs/metrics.md with catalog (Req 1-6)
-   [ ] 13.2 Add troubleshooting guide section for high latency diagnosis (Req 4/5)

## 14. Rollout & Verification

-   [ ] 14.1 Deploy Phase 1 (core metrics) -> validate
-   [ ] 14.2 Deploy Phase 2 (stage/external) -> validate
-   [ ] 14.3 Load test & record baseline dashboards

## 15. Follow-ups (Deferred)

-   [ ] 15.1 Prometheus exposition format adapter
-   [ ] 15.2 Alerting rules commit (SLO burn rate)
