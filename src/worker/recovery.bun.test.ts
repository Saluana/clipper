import { test, expect } from 'bun:test';
import { __test as workerTest } from './index';
import { createDb } from '@clipper/data';
import { eq, sql } from 'drizzle-orm';

if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/testdb';
}

// NOTE: These tests rely on a live database connection defined by DATABASE_URL.
// They insert rows, manipulate last_heartbeat_at, then invoke runRecoveryScan.

const db = createDb();

async function ensureColumns() {
    // Create columns if migration not applied (dev/test convenience)
    try {
        await db.execute(
            sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0`
        );
        await db.execute(
            sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS processing_started_at timestamptz`
        );
        await db.execute(
            sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz`
        );
    } catch {}
}

async function insertJob(row: {
    id: string;
    lastHeartbeatAt: Date;
    attemptCount: number;
}) {
    await db.execute(sql`INSERT INTO jobs (id,status,progress,source_type,start_sec,end_sec,with_subtitles,burn_subtitles,last_heartbeat_at,attempt_count,processing_started_at,created_at,updated_at)
    VALUES (${row.id}, 'processing', 0, 'upload', 0, 10, false, false, ${row.lastHeartbeatAt}, ${row.attemptCount}, ${row.lastHeartbeatAt}, now(), now())`);
}

test('recovery scan requeues stale processing job under attempt limit and emits event', async () => {
    await ensureColumns();
    const id = crypto.randomUUID();
    const stale = new Date(Date.now() - 60_000); // stale beyond default lease
    await insertJob({ id, lastHeartbeatAt: stale, attemptCount: 0 });
    const { runRecoveryScan } = workerTest as any;
    const res = await runRecoveryScan(new Date());
    expect(res.requeued).toContain(id);
    // fetch job verify status & attempt increment
    const recRes = await db.execute(
        sql`SELECT status, attempt_count FROM jobs WHERE id=${id}`
    );
    const rec = (recRes as any).rows?.[0];
    expect(rec).toBeTruthy();
    expect(rec.status).toBe('queued');
    expect(rec.attempt_count).toBe(1);
    // event existence
    const evtRes = await db.execute(
        sql`SELECT type FROM job_events WHERE job_id=${id}`
    );
    const types = (evtRes as any).rows.map((r: any) => r.type);
    expect(types).toContain('requeued:stale');
});

test('recovery scan marks job failed when attempts exhausted', async () => {
    await ensureColumns();
    const id = crypto.randomUUID();
    const stale = new Date(Date.now() - 60_000);
    // set attemptCount at max (JOB_MAX_ATTEMPTS default 3) -> should mark failed
    await insertJob({ id, lastHeartbeatAt: stale, attemptCount: 3 });
    const { runRecoveryScan } = workerTest as any;
    const res = await runRecoveryScan(new Date());
    expect(res.exhausted).toContain(id);
    const recRes = await db.execute(
        sql`SELECT status, error_code FROM jobs WHERE id=${id}`
    );
    const rec = (recRes as any).rows?.[0];
    expect(rec).toBeTruthy();
    expect(rec.status).toBe('failed');
    expect(rec.error_code).toBe('RETRIES_EXHAUSTED');
});
