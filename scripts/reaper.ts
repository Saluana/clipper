#!/usr/bin/env bun
/**
 * Reaper: requeues or fails jobs with expired leases.
 * - Works for both jobs and asr_jobs tables (if required columns exist).
 * - Uses exponential backoff for next_earliest_run_at (base/max from QUEUE_* or JOB_* envs).
 * - Writes structured JSON into job_events.data for observability.
 */
import { Pool } from 'pg';
import { readEnv } from '@clipper/common';
import { InMemoryMetrics } from '@clipper/common/metrics';
import { createLogger } from '@clipper/common/logger';

const log = (createLogger as any)((readEnv('LOG_LEVEL') as any) || 'info');

// Env helpers with sensible defaults
function int(key: string, def: number): number {
    const v = Number(readEnv(key));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
}

function getConfig() {
    const INTERVAL_SEC = int('REAPER_INTERVAL_SEC', 60);
    const MAX_ATTEMPTS_DEFAULT = int(
        'JOB_MAX_ATTEMPTS',
        int('QUEUE_MAX_ATTEMPTS', 3)
    );
    const BACKOFF_BASE_MS = int(
        'JOB_BACKOFF_MS_BASE',
        int('QUEUE_RETRY_BACKOFF_MS_BASE', 30_000)
    );
    const BACKOFF_MAX_MS = int(
        'JOB_BACKOFF_MS_MAX',
        int('QUEUE_RETRY_BACKOFF_MS_MAX', 600_000)
    );
    return {
        INTERVAL_SEC,
        MAX_ATTEMPTS_DEFAULT,
        BACKOFF_BASE_MS,
        BACKOFF_MAX_MS,
    } as const;
}

const DATABASE_URL = readEnv('DATABASE_URL');
if (!DATABASE_URL) {
    console.error('[reaper] Missing DATABASE_URL');
    process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

export type TableName = 'jobs' | 'asr_jobs';

async function columnExists(
    table: TableName,
    column: string
): Promise<boolean> {
    const q = `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1`;
    const r = await pool.query(q, [table, column]);
    const rc = (r as any)?.rowCount ?? 0;
    return rc > 0;
}

async function tableCapabilities(table: TableName) {
    const required = ['status', 'attempt_count', 'lease_expires_at'];
    const optional = ['max_attempts', 'next_earliest_run_at', 'locked_by'];
    const present: Record<string, boolean> = {} as any;
    for (const c of [...required, ...optional])
        present[c] = await columnExists(table, c);
    const ok = required.every((c) => present[c]);
    return { ok, present } as const;
}

function backoffExprSQL(): string {
    // LEAST(max, base * POWER(2, attempt_count)) in milliseconds
    return `LEAST($2::bigint, ($1::bigint * POWER(2, GREATEST(attempt_count,0))))`;
}

const metrics = new InMemoryMetrics();

async function requeueExpired(
    table: TableName,
    useMaxAttemptsCol: boolean,
    hasNextRun: boolean,
    hasLockedBy: boolean,
    cfg: {
        BACKOFF_BASE_MS: number;
        BACKOFF_MAX_MS: number;
        MAX_ATTEMPTS_DEFAULT: number;
    }
) {
    // Build UPDATE with dynamic pieces guarded by capability flags.
    const nextRunSet = hasNextRun
        ? `, next_earliest_run_at = NOW() + (${backoffExprSQL()}) * interval '1 millisecond'`
        : '';
    const clearLockedBy = hasLockedBy ? `, locked_by = NULL` : '';
    const attemptsCond = useMaxAttemptsCol
        ? `attempt_count < COALESCE(max_attempts, $3)`
        : `attempt_count < $3`;
    const nextRunWhere = hasNextRun
        ? `AND (next_earliest_run_at IS NULL OR next_earliest_run_at <= NOW())`
        : '';

    const sql = `
    UPDATE ${table}
       SET status='queued'
         ${clearLockedBy}
         , lease_expires_at = NULL
         ${nextRunSet}
     WHERE status = 'processing'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at < NOW()
       AND ${attemptsCond}
       ${nextRunWhere}
     RETURNING id, attempt_count`;

    const res = await pool.query(sql, [
        cfg.BACKOFF_BASE_MS,
        cfg.BACKOFF_MAX_MS,
        cfg.MAX_ATTEMPTS_DEFAULT,
    ]);

    // Insert job_events rows
    for (const row of res.rows as Array<{
        id: string;
        attempt_count: number;
    }>) {
        const data = {
            type: 'reaper:requeued',
            table,
            details: { reason: 'lease_expired' },
            attempt_count: row.attempt_count,
            at: new Date().toISOString(),
        };
        if (table === 'jobs') {
            await pool.query(
                `INSERT INTO job_events (job_id, type, data) VALUES ($1, $2, $3::jsonb)`,
                [row.id, 'reaper:requeued', JSON.stringify(data)]
            );
        }
    }
    const count = res.rowCount ?? 0;
    if (count > 0) metrics.inc('reaper.requeued_total', count, { table });
    return count;
}

async function failExpired(
    table: TableName,
    useMaxAttemptsCol: boolean,
    hasLockedBy: boolean,
    cfg: { MAX_ATTEMPTS_DEFAULT: number }
) {
    const clearLockedBy = hasLockedBy ? `, locked_by = NULL` : '';
    const attemptsCond = useMaxAttemptsCol
        ? `attempt_count >= COALESCE(max_attempts, $1)`
        : `attempt_count >= $1`;

    const sql = `
    UPDATE ${table}
       SET status='failed'
         , fail_code='timeout'
         , fail_reason='lease_expired'
         ${clearLockedBy}
         , lease_expires_at=NULL
     WHERE status='processing'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at < NOW()
       AND ${attemptsCond}
     RETURNING id`;

    const res = await pool.query(sql, [cfg.MAX_ATTEMPTS_DEFAULT]);
    for (const row of res.rows as Array<{ id: string }>) {
        const data = {
            type: 'reaper:failed(timeout)',
            table,
            details: { reason: 'lease_expired' },
            at: new Date().toISOString(),
        };
        if (table === 'jobs') {
            await pool.query(
                `INSERT INTO job_events (job_id, type, data) VALUES ($1, $2, $3::jsonb)`,
                [row.id, 'reaper:failed(timeout)', JSON.stringify(data)]
            );
        }
    }
    const count = res.rowCount ?? 0;
    if (count > 0)
        metrics.inc('reaper.failed_total', count, { table, code: 'timeout' });
    return count;
}

export async function reap(table: TableName) {
    const { MAX_ATTEMPTS_DEFAULT, BACKOFF_BASE_MS, BACKOFF_MAX_MS } =
        getConfig();
    const caps = await tableCapabilities(table);
    if (!caps.ok) {
        (log as any).warn?.(
            `[reaper] skipping ${table}: missing columns`,
            caps.present
        );
        return { requeued: 0, failed: 0 } as const;
    }
    const start = Date.now();
    const requeued = await requeueExpired(
        table,
        !!caps.present['max_attempts'],
        !!caps.present['next_earliest_run_at'],
        !!caps.present['locked_by'],
        { BACKOFF_BASE_MS, BACKOFF_MAX_MS, MAX_ATTEMPTS_DEFAULT }
    );
    const failed = await failExpired(
        table,
        !!caps.present['max_attempts'],
        !!caps.present['locked_by'],
        { MAX_ATTEMPTS_DEFAULT }
    );
    const dur = Date.now() - start;
    metrics.observe('reaper.scan_duration_ms', dur, { table });
    (log as any).info?.(
        `[reaper] ${table}: requeued=${requeued} failed=${failed} in ${dur}ms`
    );
    return { requeued, failed } as const;
}

async function tick() {
    try {
        await reap('jobs');
    } catch (e) {
        (log as any).error?.('[reaper] error on jobs', { err: String(e) });
    }
    try {
        await reap('asr_jobs');
    } catch (e) {
        (log as any).error?.('[reaper] error on asr_jobs', { err: String(e) });
    }
}

if ((import.meta as any).main) {
    const {
        INTERVAL_SEC,
        BACKOFF_BASE_MS,
        BACKOFF_MAX_MS,
        MAX_ATTEMPTS_DEFAULT,
    } = getConfig();
    (log as any).info?.(
        `[reaper] starting. interval=${INTERVAL_SEC}s base=${BACKOFF_BASE_MS}ms max=${BACKOFF_MAX_MS}ms maxAttempts=${MAX_ATTEMPTS_DEFAULT}`
    );
    await tick();
    setInterval(tick, INTERVAL_SEC * 1000);
}
