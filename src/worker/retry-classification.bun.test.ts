import { test, expect } from 'bun:test';
import { createDb } from '@clipper/data/db/connection';
import { jobs as jobsTable, jobEvents } from '@clipper/data/db/schema';
import { sql, eq } from 'drizzle-orm';
import '../worker/index.ts';

// Access retry helpers
// @ts-ignore
const { classifyError } = (global as any).__retryTest || {};
// @ts-ignore
const { handleRetryError } = (global as any).__retryInternal || {};
if (!classifyError || !handleRetryError)
    throw new Error('retry helpers not exposed');

const db: any = createDb();

async function insertJob(status: string, attemptCount = 0) {
    const id = crypto.randomUUID();
    await db.insert(jobsTable).values({
        id,
        status,
        progress: 0,
        sourceType: 'upload',
        startSec: 0,
        endSec: 1,
        withSubtitles: false,
        burnSubtitles: false,
        attemptCount,
    });
    return id;
}

async function getJob(id: string) {
    const [row] = await db
        .select()
        .from(jobsTable)
        .where(eq(jobsTable.id, id))
        .limit(1);
    return row;
}

async function listEvents(id: string) {
    return await db.select().from(jobEvents).where(eq(jobEvents.jobId, id));
}

test('classifyError distinguishes retryable vs fatal', () => {
    expect(classifyError(new Error('storage_upload_failed'))).toBe('retryable');
    expect(classifyError(new Error('random validation error'))).toBe('fatal');
});

test('retryable error increments attempt and requeues until max then fails', async () => {
    const id = await insertJob('processing', 0);
    // simulate three attempts with maxAttempts=2
    process.env.JOB_MAX_ATTEMPTS = '2';
    await handleRetryError(id, undefined, new Error('storage_upload_failed'));
    let j = await getJob(id);
    expect(j.attemptCount).toBe(1);
    expect(j.status).toBe('queued');
    let evts = await listEvents(id);
    expect(evts.some((e: any) => e.type === 'requeued:retry')).toBe(true);
    // second attempt should exhaust
    await handleRetryError(id, undefined, new Error('storage_upload_failed'));
    j = await getJob(id);
    expect(j.attemptCount).toBe(2);
    expect(j.status).toBe('failed');
    evts = await listEvents(id);
    expect(evts.filter((e: any) => e.type === 'failed').length).toBeGreaterThan(
        0
    );
});

test('fatal error marks failed without attempt increment beyond current', async () => {
    const id = await insertJob('processing', 1);
    const before = (await getJob(id)).attemptCount;
    await handleRetryError(id, 'cid', new Error('validation_problem'));
    const after = (await getJob(id)).attemptCount;
    expect(after).toBe(before); // unchanged
    const evts = await listEvents(id);
    expect(evts.filter((e: any) => e.type === 'failed').length).toBeGreaterThan(
        0
    );
});
