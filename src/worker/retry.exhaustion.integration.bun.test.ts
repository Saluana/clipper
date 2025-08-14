import { test, expect } from 'bun:test';
import { createDb } from '@clipper/data';
import { jobs as jobsTable } from '@clipper/data/db/schema';
import { eq } from 'drizzle-orm';
import '../worker/index.ts';

const db: any = createDb();

async function insertProcessingJob(id: string, attemptCount = 0) {
    await db.insert(jobsTable).values({
        id,
        status: 'processing',
        progress: 0,
        sourceType: 'upload',
        startSec: 0,
        endSec: 1,
        withSubtitles: false,
        burnSubtitles: false,
        attemptCount,
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

// @ts-ignore
const { handleRetryError } = (globalThis as any).__retryInternal || {};

if (!handleRetryError) throw new Error('missing retry helper');

test('retry exhaustion marks failed with RETRIES_EXHAUSTED', async () => {
    const id = crypto.randomUUID();
    await insertProcessingJob(id, 2);
    process.env.JOB_MAX_ATTEMPTS = '3';
    await handleRetryError(id, 'cid', new Error('storage_upload_failed'));
    const job = await getJob(id);
    expect(job.status).toBe('failed');
    expect(job.errorCode).toBe('RETRIES_EXHAUSTED');
});
