import { test, expect } from 'vitest';
import { cleanupExpiredJobs } from '../cleanup';
import { createDb } from '../db/connection';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { jobs, type NewJob } from '../db/schema';
import { eq } from 'drizzle-orm';
import { storageKeys } from '../storage';

const HAS_DB = !!process.env.DATABASE_URL;

class MemoryStorage {
    removed: string[] = [];
    async remove(key: string) {
        this.removed.push(key);
    }
    async upload() {
        /* no-op */
    }
    async sign() {
        return '';
    }
    async download() {
        return '/tmp/fake';
    }
}

test.runIf(HAS_DB)('cleanup removes expired job objects', async () => {
    const db = createDb();
    const migrationsFolder = new URL('../../data/drizzle', import.meta.url)
        .pathname;
    await migrate(db, { migrationsFolder });
    const jobId = crypto.randomUUID();
    const videoKey = storageKeys.resultVideo(jobId);
    const srtKey = storageKeys.resultSrt(jobId);
    const row: NewJob = {
        id: jobId,
        status: 'done',
        progress: 100,
        sourceType: 'upload',
        startSec: 0,
        endSec: 1,
        withSubtitles: false,
        burnSubtitles: false,
        resultVideoKey: videoKey,
        resultSrtKey: srtKey,
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() - 1000),
    } as any; // allow partial
    await db.insert(jobs).values(row);
    const storage = new MemoryStorage();
    const res = await cleanupExpiredJobs({ dryRun: false, storage });
    expect(res.deletedJobs).toBeGreaterThanOrEqual(1);
    expect(storage.removed).toEqual(expect.arrayContaining([videoKey, srtKey]));
    const remaining = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(remaining.length).toBe(0);
});
