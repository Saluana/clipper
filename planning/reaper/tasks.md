# tasks.md

artifact_id: 9c2d1a4f-6e7b-4aaf-8f4f-2c3e9b0d4a11

1. Reaper service (core) [ ]

    - Create `scripts/reaper.ts` that runs every `REAPER_INTERVAL_SEC` and calls `reap(table)` for `jobs` and `asr_jobs`. (Requirements: 1,2,6,7)
    - Implement `reap(table)` to perform two `UPDATE ... RETURNING` statements (requeue and fail). Insert `job_events` rows and emit metrics. (Requirements: 1,2,6)
    - Add `start:reaper` to `package.json` scripts and docs. (Requirements: 7)

2. Schema migrations [ ]

    - Add nullable fields to `jobs` and `asr_jobs`: `locked_by`, `lease_expires_at`, `last_heartbeat_at`, `attempt_count` (default 0), `max_attempts` (default 3), `fail_code`, `fail_reason`, `stage`, `next_earliest_run_at`, `expected_duration_ms`. Create indexes on `(status, lease_expires_at)`. (Requirements: 3,8)
    - Reuse existing `job_events(job_id, data)` for logging reaper actions; no new table. (Requirements: 6)

3. Worker changes (claim + heartbeat) [ ]

    - Update worker claim logic to set `status`, `locked_by`, `attempt_count=attempt_count+1`, `lease_expires_at`, `last_heartbeat_at`, and `processing_started_at` in a single UPDATE. Use `SKIP LOCKED` selection to avoid races. (Requirements: 2,3,4)
    - Add heartbeat timer (10-15s) in workers that extend `lease_expires_at`. (Requirements: 4)
    - On finish or error, clear lock fields and set `state=done|failed`. (Requirements: 2,5)

4. Backoff & scheduling [ ]

    - On requeue, set `next_earliest_run_at` with exponential backoff per attempt. Ensure workers respect `next_earliest_run_at` when selecting jobs. Use `QUEUE_RETRY_BACKOFF_MS_BASE/MAX` as defaults; allow overrides. (Requirements: 5)

5. Tests [ ]

    - Unit tests for backoff calculation and SLA calculations. (Requirement: 10)
    - Integration tests for reaper behavior (requeue vs fail). (Requirement: 10)

6. Observability [ ]
    - Add metrics emission to existing metrics system for reaper counts and latency. (Requirement: 6)
    - If queuing is mediated via pg-boss, ensure requeue path fits the dispatcher: status='queued' + backoff respected by poller, or optionally republish via queue adapter. (Requirement: 7)
    - Ensure `job_events` are written with `reaper:requeued` / `reaper:failed(timeout)` and necessary details. (Requirement: 6)

Notes:

-   Keep task list short and crisp: the above are the minimum required to ship a safe reaper.
-   Prioritize schema + worker changes + reaper service. Tests and observability follow immediately after.
