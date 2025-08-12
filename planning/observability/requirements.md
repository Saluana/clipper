# Observability Improvements Requirements

artifact_id: 1c6f4f3c-0c5f-4a6c-9f6b-2c6c8f3c1e01

## Introduction

Define and implement comprehensive observability (metrics, logging enhancements, tracing readiness, health diagnostics) to enable tuning performance, capacity planning, SLO monitoring, and rapid incident response. Current state: minimal ad-hoc counters, no standardized histograms, limited worker stage visibility, no alerting semantics.

## Roles

-   Operator / SRE – monitors health and performance, responds to incidents
-   Developer – uses metrics & traces for debugging latency/failures
-   Product/Stakeholder – views high-level throughput & success rates

## Functional Requirements

1. Metric Registry & Naming

-   Story: As an operator I want a consistent metrics namespace so I can build reliable dashboards.
-   Acceptance:
    -   WHEN the service boots THEN it SHALL register a fixed set of metric instruments (counters, histograms, gauges) without dynamic per-ID label creation.
    -   IF a new domain metric is added THEN its name SHALL follow `<domain>.<action>[_<unit>]` and be documented in metrics reference.

2. HTTP Request Metrics

-   Story: As an operator I want latency & outcome visibility for every API endpoint.
-   Acceptance:
    -   WHEN any HTTP request completes THEN counters SHALL increment: `http.requests_total{method,route,code}` and latency SHALL observe in `http.request_latency_ms{route}` histogram.
    -   IF an unhandled error occurs THEN `http.errors_total{route,code}` SHALL increment.

3. Job Lifecycle Metrics

-   Story: As an operator I want to understand job flow and queue health.
-   Acceptance:
    -   WHEN a job is created THEN increment `jobs.created_total`.
    -   WHEN status transitions occur THEN increment `jobs.status_transition_total{from,to}`.
    -   WHEN a job finishes THEN observe total processing time in `jobs.total_latency_ms`.
    -   Queue snapshot endpoint `/metrics/queue` SHALL include depth, active, oldestAgeSec.

4. Worker Stage Timings

-   Story: As a developer I need per-stage breakdown (resolve, probe, download, clip, upload, asr) to locate bottlenecks.
-   Acceptance:
    -   WHEN a stage starts/ends THEN the duration SHALL be observed in `worker.stage_latency_ms{stage}`.
    -   IF a stage fails THEN increment `worker.stage_failures_total{stage,code}`.

5. External Dependency Metrics

-   Story: As an operator I want to know if upstream (yt-dlp, ffmpeg, storage, ASR) cause latency/errors.
-   Acceptance:
    -   Each external call SHALL record `external.call_latency_ms{service,op}` histogram and `external.calls_total{service,op,outcome}` counter.
    -   Failures SHALL include sanitized error classification labels (`timeout|error|not_found|blocked`).

6. Resource Utilization Probes

-   Story: As an operator I want basic runtime resource telemetry without heavyweight agents.
-   Acceptance:
    -   A sampler every 15s SHALL update gauges: `proc.memory_rss_mb`, `proc.open_fds` (best-effort), `scratch.disk_used_pct`, `event_loop.lag_ms`.

7. Structured Logging Consistency

-   Story: As a developer I want every request log to contain correlationId for traceability.
-   Acceptance:
    -   WHEN an HTTP request starts THEN a correlationId SHALL be generated (or reused) and included in all subsequent log entries for that request and job events.
    -   Sensitive fields SHALL be redacted using existing redact utilities.

8. Event Emission & Persistence

-   Story: As an operator I want durable job event timelines for post-mortem analysis.
-   Acceptance:
    -   WHEN job events are emitted they SHALL be appended to `job_events` repository and (optionally) streamed out; failures to persist SHALL surface metrics `events.persist_failures_total`.

9. Health & Readiness

-   Story: As an operator I need clear health signals for orchestration.
-   Acceptance:
    -   GET /healthz SHALL return queue connectivity, DB ping latency, worker active status summary.<br>
    -   IF DB or queue is unreachable THEN health SHALL be `ok:false` with code.

10. SLO Definition & Burn Rate Indicators

-   Story: As an operator I need automated alert thresholds.
-   Acceptance:
    -   SLOs SHALL be documented: (a) 99% jobs success; (b) P95 clip latency bound; (c) Error budget 1% failures.
    -   Derived metrics (recorded or query-level) for 5m, 1h error rates SHALL be feasible without additional code changes.

11. Metrics Endpoint Stability

-   Story: As an operator I want the metrics endpoint to avoid heavy allocation under load.
-   Acceptance:
    -   /metrics serialization SHALL execute within <50ms for 95th percentile under 10k instruments.

12. Tracing Readiness (Optional Flag)

-   Story: As an engineer I want to enable tracing without refactoring core logic.
-   Acceptance:
    -   Code SHALL include abstractions (startSpan/endSpan) no-ops when tracing disabled.

## Non-Functional Requirements

-   Label Cardinality: Max 10 distinct values per label; route placeholders merged (e.g. /api/jobs/:id).
-   Overhead: Observability instrumentation MUST add <5% CPU overhead at P95 typical workload.
-   Security: Logs & metrics SHALL NOT contain raw secrets, signed URLs, full tokens.
-   Reliability: Metrics updates SHALL not throw; failures degrade silently (warn log once per interval).

## Constraints

-   No persistent metrics store beyond in-memory snapshot (Prometheus style future). JSON snapshot retained.
-   Bun runtime; avoid native deps beyond existing.

## Out of Scope (Phase 1)

-   Full distributed tracing backend integration
-   Alert manager configuration
-   Persistent historical metrics storage

## Acceptance Validation

-   Load test script demonstrates metrics non-zero and SLO calculations; unit tests for metric registry naming; integration test ensures /metrics returns expected shape.
