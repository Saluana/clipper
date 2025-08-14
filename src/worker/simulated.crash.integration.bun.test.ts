import { test, expect } from 'bun:test';
import { createDb } from '@clipper/data';
import { jobs as jobsTable, jobEvents } from '@clipper/data/db/schema';
import { sql, eq } from 'drizzle-orm';
import { __test as workerTest } from '../worker/index.ts';

const db: any = createDb();

async function insertProcessingJob(
    id: string,
    lastHeartbeatAt: Date,
    attemptCount = 0
) {
    await db.insert(jobsTable).values({
        id,
        status: 'processing',
        progress: 50,
        sourceType: 'upload',
        startSec: 0,
        endSec: 2,
        withSubtitles: false,
        burnSubtitles: false,
        lastHeartbeatAt,
        attemptCount,
        processingStartedAt: lastHeartbeatAt,
    });
}

async function getJob(id: string) {
    const [row] = await db
        .select()
        .from(jobsTable)
        .where(eq(jobsTable.id, id))
        .limit(1);
    return row;
}

async function listEventTypes(id: string) {
    const rows = await db
        .select()
        .from(jobEvents)
        .where(eq(jobEvents.jobId, id));
    return rows
        .sort((a: any, b: any) => a.ts.localeCompare(b.ts))
        .map((e: any) => e.type);
}

test('simulated crash -> recovery requeues stale job', async () => {
    const id = crypto.randomUUID();
    const stale = new Date(Date.now() - 60_000);
    // Ensure columns (dev/test convenience)
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
    await insertProcessingJob(id, stale, 0);
    const { runRecoveryScan } = workerTest as any;
    expect(runRecoveryScan).toBeTypeOf('function');
    const res = await runRecoveryScan(new Date());
    expect(res.requeued).toContain(id);
    const j = await getJob(id);
    expect(j.status).toBe('queued');
    const types = await listEventTypes(id);
    expect(types).toContain('requeued:stale');
});
