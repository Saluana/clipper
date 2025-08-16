import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDb } from '@clipper/data';
import {
    jobs as jobsTable,
    jobEvents,
    asrJobs as asrJobsTable,
} from '@clipper/data/db/schema';
import { sql, eq } from 'drizzle-orm';
import { reap } from '../../scripts/reaper';

const hasDb = !!process.env.DATABASE_URL;

describe('reaper integration', () => {
    if (!hasDb) {
        it('skipped (no DATABASE_URL)', () => {
            expect(true).toBe(true);
        });
        return;
    }

    const db = createDb();

    beforeAll(() => {
        // Set tight backoff to make assertions easier
        process.env.JOB_BACKOFF_MS_BASE = '1000';
        process.env.JOB_BACKOFF_MS_MAX = '1000';
        process.env.REAPER_INTERVAL_SEC = '60';
    });

    afterAll(async () => {
        // nothing global
    });

    it('requeues expired lease when attempts < max and writes event + next_earliest_run_at', async () => {
        const id = crypto.randomUUID();
        const past = new Date(Date.now() - 5_000);
        await (db as any).insert(jobsTable).values({
            id,
            status: 'processing',
            sourceType: 'upload',
            startSec: 0,
            endSec: 10,
            leaseExpiresAt: past,
            attemptCount: 0,
            maxAttempts: 3,
        });

        await reap('jobs');

        const rows = await (db as any)
            .select()
            .from(jobsTable)
            .where(eq(jobsTable.id, id));
        expect(rows.length).toBe(1);
        const row = rows[0];
        expect(row.status).toBe('queued');
        expect(row.leaseExpiresAt).toBeNull();
        // next_earliest_run_at should be set
        expect(row.nextEarliestRunAt).toBeTruthy();

        const ev = await (db as any)
            .select()
            .from(jobEvents)
            .where(eq(jobEvents.jobId, id));
        const types = new Set(ev.map((e: any) => e.type));
        expect(types.has('reaper:requeued')).toBe(true);

        // cleanup
        await (db as any).delete(jobEvents).where(eq(jobEvents.jobId, id));
        await (db as any).delete(jobsTable).where(eq(jobsTable.id, id));
    });

    it('fails expired lease when attempts >= max and writes event', async () => {
        const id = crypto.randomUUID();
        const past = new Date(Date.now() - 5_000);
        await (db as any).insert(jobsTable).values({
            id,
            status: 'processing',
            sourceType: 'upload',
            startSec: 0,
            endSec: 10,
            leaseExpiresAt: past,
            attemptCount: 3,
            maxAttempts: 3,
        });

        await reap('jobs');

        const rows = await (db as any)
            .select()
            .from(jobsTable)
            .where(eq(jobsTable.id, id));
        expect(rows.length).toBe(1);
        const row = rows[0];
        expect(row.status).toBe('failed');
        expect(row.failCode).toBe('timeout');
        expect(row.failReason).toBe('lease_expired');

        const ev = await (db as any)
            .select()
            .from(jobEvents)
            .where(eq(jobEvents.jobId, id));
        const types = new Set(ev.map((e: any) => e.type));
        expect(types.has('reaper:failed(timeout)')).toBe(true);

        // cleanup
        await (db as any).delete(jobEvents).where(eq(jobEvents.jobId, id));
        await (db as any).delete(jobsTable).where(eq(jobsTable.id, id));
    });

    it('does not touch processing with a fresh lease (no events)', async () => {
        const id = crypto.randomUUID();
        const future = new Date(Date.now() + 60_000);
        await (db as any).insert(jobsTable).values({
            id,
            status: 'processing',
            sourceType: 'upload',
            startSec: 0,
            endSec: 10,
            leaseExpiresAt: future,
            attemptCount: 0,
            maxAttempts: 3,
        });

        await reap('jobs');

        const [row] = await (db as any)
            .select()
            .from(jobsTable)
            .where(eq(jobsTable.id, id));
        expect(row.status).toBe('processing');

        const ev = await (db as any)
            .select()
            .from(jobEvents)
            .where(eq(jobEvents.jobId, id));
        expect(ev.length).toBe(0);

        // cleanup
        await (db as any).delete(jobsTable).where(eq(jobsTable.id, id));
    });

    it('uses env default when max_attempts is NULL (COALESCE) for requeue and fail', async () => {
        // Set env default to 2
        process.env.JOB_MAX_ATTEMPTS = '2';
        // Case 1: attempt 0 -> requeue
        const id1 = crypto.randomUUID();
        await (db as any).insert(jobsTable).values({
            id: id1,
            status: 'processing',
            sourceType: 'upload',
            startSec: 0,
            endSec: 10,
            leaseExpiresAt: new Date(Date.now() - 1000),
            attemptCount: 0,
            maxAttempts: null,
        });
        await reap('jobs');
        const [r1] = await (db as any)
            .select()
            .from(jobsTable)
            .where(eq(jobsTable.id, id1));
        expect(r1.status).toBe('queued');
        // Case 2: attempt 2 -> fail
        const id2 = crypto.randomUUID();
        await (db as any).insert(jobsTable).values({
            id: id2,
            status: 'processing',
            sourceType: 'upload',
            startSec: 0,
            endSec: 10,
            leaseExpiresAt: new Date(Date.now() - 1000),
            attemptCount: 2,
            maxAttempts: null,
        });
        await reap('jobs');
        const [r2] = await (db as any)
            .select()
            .from(jobsTable)
            .where(eq(jobsTable.id, id2));
        expect(r2.status).toBe('failed');

        // cleanup
        await (db as any).delete(jobEvents).where(eq(jobEvents.jobId, id1));
        await (db as any).delete(jobEvents).where(eq(jobEvents.jobId, id2));
        await (db as any).delete(jobsTable).where(eq(jobsTable.id, id1));
        await (db as any).delete(jobsTable).where(eq(jobsTable.id, id2));
    });

    it('clears locked_by on requeue and fail', async () => {
        const idA = crypto.randomUUID();
        const idB = crypto.randomUUID();
        await (db as any).insert(jobsTable).values([
            {
                id: idA,
                status: 'processing',
                sourceType: 'upload',
                startSec: 0,
                endSec: 10,
                leaseExpiresAt: new Date(Date.now() - 1000),
                attemptCount: 0,
                maxAttempts: 3,
                lockedBy: 'worker-x',
            },
            {
                id: idB,
                status: 'processing',
                sourceType: 'upload',
                startSec: 0,
                endSec: 10,
                leaseExpiresAt: new Date(Date.now() - 1000),
                attemptCount: 3,
                maxAttempts: 3,
                lockedBy: 'worker-y',
            },
        ]);
        await reap('jobs');
        const [a] = await (db as any)
            .select()
            .from(jobsTable)
            .where(eq(jobsTable.id, idA));
        const [b] = await (db as any)
            .select()
            .from(jobsTable)
            .where(eq(jobsTable.id, idB));
        expect(a.lockedBy).toBeNull();
        expect(b.lockedBy).toBeNull();
        await (db as any).delete(jobEvents).where(eq(jobEvents.jobId, idA));
        await (db as any).delete(jobEvents).where(eq(jobEvents.jobId, idB));
        await (db as any).delete(jobsTable).where(eq(jobsTable.id, idA));
        await (db as any).delete(jobsTable).where(eq(jobsTable.id, idB));
    });

    it('applies exponential backoff for next_earliest_run_at (bounded by max)', async () => {
        // Base 500ms, max 10_000ms, attempt_count=2 -> expected ~2000ms
        process.env.JOB_BACKOFF_MS_BASE = '500';
        process.env.JOB_BACKOFF_MS_MAX = '10000';
        const id = crypto.randomUUID();
        await (db as any).insert(jobsTable).values({
            id,
            status: 'processing',
            sourceType: 'upload',
            startSec: 0,
            endSec: 10,
            leaseExpiresAt: new Date(Date.now() - 1000),
            attemptCount: 2,
            maxAttempts: 5,
        });
        const before = Date.now();
        await reap('jobs');
        const [row] = await (db as any)
            .select()
            .from(jobsTable)
            .where(eq(jobsTable.id, id));
        const delta = new Date(row.nextEarliestRunAt).getTime() - before;
        expect(delta).toBeGreaterThanOrEqual(1500);
        expect(delta).toBeLessThanOrEqual(6000);
        await (db as any).delete(jobEvents).where(eq(jobEvents.jobId, id));
        await (db as any).delete(jobsTable).where(eq(jobsTable.id, id));
    });

    it('reaps ASR jobs similarly (requeue path)', async () => {
        const id = crypto.randomUUID();
        await (db as any).insert(asrJobsTable).values({
            id,
            status: 'processing',
            sourceType: 'upload',
            mediaHash: 'hash123',
            modelVersion: 'v1',
            leaseExpiresAt: new Date(Date.now() - 1000),
            attemptCount: 0,
            maxAttempts: 3,
        });
        await reap('asr_jobs');
        const [row] = await (db as any)
            .select()
            .from(asrJobsTable)
            .where(eq(asrJobsTable.id, id));
        expect(row.status).toBe('queued');
        await (db as any).delete(jobEvents).where(eq(jobEvents.jobId, id));
        await (db as any).delete(asrJobsTable).where(eq(asrJobsTable.id, id));
    });
});
