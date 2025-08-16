# requirements.md

artifact_id: 7f8c2b6a-3c1b-4f8f-9b3e-1d22b9c7a5a2

## Introduction

Add a robust stuck-job reaper to the system that uses leases, heartbeats, retries, and stage-aware timeouts. Goal: ensure no job remains indefinitely stuck in `processing` while also avoiding premature failure of legitimately long-running ffmpeg/ASR tasks. The reaper must emit events and metrics. Align naming with the repo: `jobs` (clip pipeline) and `asr_jobs`, columns `status`, `last_heartbeat_at`, `attempt_count`.

## Requirements

1. As an operator, I want jobs to be safely requeued when their worker dies or stops heartbeating, so that transient worker failures do not cause permanent job loss.

    WHEN a job is in `processing` (status='processing') AND its `lease_expires_at` < NOW() AND `attempt_count` < `max_attempts` THEN the system SHALL set the job back to `queued`, clear lock fields, set `next_earliest_run_at` with backoff, record an event `reaper:requeued` in `job_events.data`, and increment a metric `reaper.requeues`.

2. As an operator, I want jobs that exceed max attempts to be moved to a dead-letter/failure state with diagnostic info, so we can inspect and fix persistent failures.

    WHEN a job is in `processing` AND its `lease_expires_at` < NOW() AND `attempt_count` >= `max_attempts` THEN the system SHALL set the job status to `failed`, set `fail_code='timeout'` and `fail_reason='lease_expired'`, clear lock fields, record an event `reaper:failed(timeout)` in `job_events.data`, and increment a metric `reaper.failures`.

3. As a developer, I want per-stage SLAs so long-running stages (ASR, burn-in) are not prematurely reaped.

    WHEN a worker picks a job it SHALL set `lease_expires_at = NOW() + stage_lease_sec` where `stage_lease_sec` is chosen according to the job stage (clip|asr|burnin) and environment-configured SLA factors. The system SHALL expose environment variables to tune these values.

4. As an operator, I want heartbeats so running workers extend leases and are not reaped while still active.

    WHEN a worker is processing a job it SHALL update `last_heartbeat_at=NOW()` and extend `lease_expires_at=NOW()+stage_lease_sec` every 10-15s.

5. As an operator, I want backoff between retries to avoid hot loops.

    WHEN a job is requeued by the reaper the system SHALL set `next_earliest_run_at = NOW() + backoff` where backoff grows per attempt (e.g. 30s, 2m, 10m), and SHALL not immediately re-dispatch the job.

6. As an engineer, I want events and metrics from reaper actions for observability.

    WHEN the reaper requeues or fails a job it SHALL insert an event row in `job_events` (JSON in `data` with `type`, `table`, `details`) and emit metrics `reaper.requeues`, `reaper.failures`, and `reaper.scan_duration_ms`.

7. Non-functional: The reaper SHALL run every 60s by default (configurable via `REAPER_INTERVAL_SEC`) and be resilient to errors (log and continue). It SHALL be able to run as a single instance in-app service.
   It SHALL prefer existing `QUEUE_*` envs for defaults (e.g., `QUEUE_MAX_ATTEMPTS`, `QUEUE_RETRY_BACKOFF_MS_BASE/MAX`) and accept `JOB_*` overrides.

8. Non-functional: All changes SHALL be backward compatible: adding nullable fields and defaults. Reaper behavior SHALL be safe even if older workers don't set leases (tolerate NULLs).

9. Non-functional: The system SHALL avoid races with workers by using transactional updates and `FOR UPDATE SKIP LOCKED` when scanning.

10. Non-functional: The reaper SHALL be tested by unit and integration tests that simulate expired leases, heartbeats, and backoff behavior.
