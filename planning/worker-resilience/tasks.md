# Worker Runtime Resilience Tasks

artifact_id: a7e5c1d2-3b4f-45c6-8d17-9f1e2d3c4b5a

## 1. Schema Migration

-   [x] 1.1 Add last_heartbeat_at, attempt_count, processing_started_at columns (Req 1/2/7)
-   [x] 1.2 Add index (status, last_heartbeat_at) (Req 2)

## 2. Heartbeat Implementation

-   [x] 2.1 Track active job IDs list (Req 1)
-   [x] 2.2 Batch update heartbeat loop (Req 1)
-   [x] 2.3 Warning log on >3 consecutive failures (Req 1)

## 3. Recovery Scanner

-   [x] 3.1 Implement recovery scan SQL (Req 2)
-   [x] 3.2 Emit requeued:stale events (Req 2)
-   [x] 3.3 Attempt limit fail path RETRIES_EXHAUSTED (Req 7)

## 4. Concurrency Control

-   [x] 4.1 Implement semaphore (Req 3)
-   [x] 4.2 Prefetch logic constrained by available slots (Req 3) _(basic: queue handler acquire gate)_
-   [x] 4.3 Gauge worker.concurrent_jobs (Req 3)

## 5. Backpressure Pause

-   [ ] 5.1 Monitor queue depth + CPU load (Req 4)
-   [ ] 5.2 Pause dequeuing under high watermark (Req 4)
-   [ ] 5.3 Metric worker.pauses_total (Req 4)

## 6. Idempotent Output Handling

-   [ ] 6.1 Implement temp -> atomic move pattern (Req 5)
-   [ ] 6.2 Pre-check existing artifact skip path (Req 5)
-   [ ] 6.3 Integrity validation (size > 0) (Req 5)

## 7. Duplicate Suppression

-   [ ] 7.1 Atomic queued->processing update (Req 6)
-   [ ] 7.2 Track acquire conflicts metric (Req 6)

## 8. Retry Classification

-   [ ] 8.1 Implement classify(err) (Req 7)
-   [ ] 8.2 Update attempt_count on retry (Req 7)
-   [ ] 8.3 Fail fast on fatal (Req 7)

## 9. Progress Throttling

-   [ ] 9.1 Implement delta/time based throttler (Req 8)
-   [ ] 9.2 Persist last progress percent (Req 8)

## 10. Scratch Management

-   [ ] 10.1 Delete scratch on success (Req 9)
-   [ ] 10.2 Preserve on failure with size log (Req 9)

## 11. Graceful Shutdown

-   [ ] 11.1 SIGTERM handler: stop dequeue (Req 10)
-   [ ] 11.2 Wait for active jobs with timeout (Req 10)
-   [ ] 11.3 Abort events for timed out jobs (Req 10)

## 12. Observability Metrics

-   [ ] 12.1 heartbeats_total, heartbeat_failures_total (Req 11)
-   [ ] 12.2 recovered_jobs_total{reason} (Req 11)
-   [ ] 12.3 retry_attempts_total{code} (Req 11)
-   [ ] 12.4 duplicate_skips_total & acquire_conflicts_total (Req 6/11)

## 13. Event Timeline Consistency

-   [ ] 13.1 Ensure event ordering logic (Req 12)
-   [ ] 13.2 Test normal + recovery sequences (Req 12)

## 14. Testing & Simulation

-   [ ] 14.1 Integration test simulated crash (Req 2)
-   [ ] 14.2 Concurrency limit test (Req 3)
-   [ ] 14.3 Retry exhaustion test (Req 7)
-   [ ] 14.4 Idempotent artifact skip test (Req 5)

## 15. Rollout

-   [ ] 15.1 Deploy migration only
-   [ ] 15.2 Enable heartbeat & logging (observe only)
-   [ ] 15.3 Enable recovery scanner (low frequency)
-   [ ] 15.4 Increase scan frequency & enable attempt limits

## 16. Future Enhancements

-   [ ] 16.1 Dynamic lease timeout based on clip duration
-   [ ] 16.2 Per-stage adaptive concurrency
