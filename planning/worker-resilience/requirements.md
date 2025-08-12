# Worker Runtime Resilience Requirements

artifact_id: 4e5f0d2c-62a8-476d-a0f4-f3f6c5c41d0e

## Introduction

Harden worker execution against crashes, duplicates, and partial progress loss by implementing heartbeats, lease recovery, controlled concurrency, idempotent processing, and safe artifact publication. Current gaps: conceptual heartbeat mention but no implemented lease reclamation or duplicate suppression.

## Roles

-   Worker Process – executes jobs
-   Operator – monitors stuck/failed jobs
-   Developer – relies on deterministic state transitions for debugging

## Functional Requirements

1. Heartbeat Mechanism

-   Story: As an operator I want to detect stuck jobs.
-   Acceptance:
    -   WHILE worker processes a job it SHALL update `jobs.lastHeartbeatAt` every HEARTBEAT_INTERVAL_SEC (default 10).
    -   IF a heartbeat update fails consecutively >3 times THEN a warning log emitted with code HEARTBEAT_DEGRADED.

2. Lease Expiration & Recovery

-   Story: As a system I must reclaim orphaned jobs when a worker dies.
-   Acceptance:
    -   A recovery loop SHALL scan for jobs status=processing with lastHeartbeatAt older than LEASE_TIMEOUT_SEC (default 3 \* heartbeat interval) and set status=queued with attemptCount+1 if attemptCount < MAX_ATTEMPTS.
    -   Recovered jobs SHALL emit event `requeued:stale`.

3. Concurrency Control

-   Story: As an operator I want to bound resource usage.
-   Acceptance:
    -   Worker SHALL respect MAX_CONCURRENCY (env) and not start more simultaneous clip tasks than limit.
    -   In-flight count exposed via metric worker.inflight_jobs.

4. Backpressure & Queue Depth Awareness

-   Story: As a system I want to adapt to load spikes.
-   Acceptance:
    -   IF queue depth > HIGH_WATERMARK AND CPU load > LOAD_THRESHOLD THEN worker SHALL pause dequeuing new jobs for PAUSE_INTERVAL_SEC.
    -   Metric worker.pauses_total increments on each pause.

5. Idempotent Job Processing

-   Story: As an operator I want repeatable outcomes after restarts.
-   Acceptance:
    -   Output storage key SHALL be deterministic: results/{jobId}/clip.mp4.
    -   Processing SHALL use a temp file path then atomic move to final, ensuring partial writes never appear at final key.
    -   On retry for same jobId pre-existing successful artifact SHALL short-circuit and mark done if integrity validated.

6. Duplicate Start Suppression

-   Story: As a system I must prevent two workers from processing same job concurrently.
-   Acceptance:
    -   Job acquisition SHALL perform atomic transition queued->processing (e.g., UPDATE ... WHERE status='queued') and only proceed if rowCount=1.
    -   If a job already processing and within lease (fresh heartbeat) second worker SHALL skip.

7. Attempt Limits & Failure Classification

-   Story: As an operator I want bounded retries and clear error states.
-   Acceptance:
    -   Transient errors (storage upload timeout, network failures) SHALL be retried up to MAX_ATTEMPTS (default 3) then marked failed with code RETRIES_EXHAUSTED.
    -   Non-retryable errors (validation, INPUT_TOO_LARGE) SHALL immediately mark failed (no further retries) attemptCount remains.

8. Progress Tracking & Throttling

-   Story: As a client I want timely but not noisy progress.
-   Acceptance:
    -   Progress events SHALL be emitted only if pct increased by >=1 OR ≥500ms since last event OR final 100.
    -   Worker SHALL persist last progress percent for status endpoint.

9. Safe Cleanup & Scratch Management

-   Story: As an operator I want no unbounded disk growth.
-   Acceptance:
    -   On success worker SHALL delete scratch job directory unless KEEP_SCRATCH_ON_SUCCESS=1.
    -   On failure scratch preserved for inspection with size logged; cleanup script handles old failure dirs.

10. Graceful Shutdown

-   Story: As an operator I want zero lost jobs during redeploy.
-   Acceptance:
    -   On SIGTERM worker SHALL stop dequeuing new jobs, wait (shutdownTimeout) for active jobs to finish or reach safe checkpoint, then exit.
    -   Active jobs exceeding shutdown timeout SHALL record event `aborted:shutdown` and rely on lease recovery.

11. Observability Integration

-   Story: As an operator I want visibility into resilience behavior.
-   Acceptance:
    -   Metrics: worker.heartbeats_total, worker.recovered_jobs_total{reason}, worker.retry_attempts_total{code}, worker.duplicate_skips_total, worker.atomic_acquire_fail_total.

12. Consistent Event Emission

-   Story: As a developer I want a deterministic event timeline.
-   Acceptance:
    -   Event order for successful job: created -> processing -> source:ready -> progress\* -> uploaded -> done.
    -   Recovery path inserts `requeued:stale` before processing (again).

## Non-Functional Requirements

-   Robustness: Single worker crash recovery within <= lease timeout + queue dispatch latency.
-   Performance: Heartbeat updates batched or lightweight (<1ms each).
-   Safety: No partial artifacts published; idempotent retries safe to re-run.

## Constraints

-   Use existing Postgres and pg-boss; no new infra for locking.
-   Assume monotonic system clock (drift <1s across workers) for heartbeat validity.

## Out of Scope

-   Cross-region failover
-   Dynamic autoscaling controller (basic env-based scaling only)

## Acceptance Validation

-   Tests simulate crash mid-clip -> verify requeue & eventual success.
-   Duplicate worker simulation ensures only one processes job concurrently.
-   Attempt exhaustion path yields RETRIES_EXHAUSTED.
