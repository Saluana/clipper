import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { DrizzleJobsRepo, DrizzleJobEventsRepo, createDb } from '..';
import { readEnv } from '../../common/index';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { jobs } from '../db/schema';
import { eq } from 'drizzle-orm';
import { storageKeys, createSupabaseStorageRepo } from '../storage';
import { createClient } from '@supabase/supabase-js';
import { writeFile, unlink } from 'node:fs/promises';
import { cleanupExpiredJobs } from '../cleanup';
import { DrizzleApiKeysRepo } from '../api-keys';

const hasDb = !!readEnv('DATABASE_URL');

// Supabase envs (core: url + service key)
const SUPABASE_URL = readEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = readEnv('SUPABASE_SERVICE_ROLE_KEY');
const SUPABASE_STORAGE_BUCKET = readEnv('SUPABASE_STORAGE_BUCKET');
const missingSupabaseCore = [
    ['SUPABASE_URL', SUPABASE_URL],
    ['SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY],
]
    .filter(([, v]) => !v)
    .map(([k]) => k);
const hasSupabaseCore = missingSupabaseCore.length === 0;

describe('Data Layer Integration', () => {
    // Auto-apply migrations once when DB is available
    if (hasDb) {
        beforeAll(async () => {
            const db = createDb();
            const migrationsFolder = new URL('../drizzle', import.meta.url)
                .pathname;
            await migrate(db, { migrationsFolder });
        });
    }

    if (hasDb) {
        test('db repos: create/get/list/update/transition/events', async () => {
            const db = createDb();
            const jobsRepo = new DrizzleJobsRepo(db);
            const eventsRepo = new DrizzleJobEventsRepo(db);

            const jobId = crypto.randomUUID();
            const created = await jobsRepo.create({
                id: jobId,
                status: 'queued',
                progress: 0,
                sourceType: 'upload',
                startSec: 0,
                endSec: 1,
                withSubtitles: false,
                burnSubtitles: false,
            });
            expect(created.id).toBe(jobId);
            expect(created.status).toBe('queued');

            const got = await jobsRepo.get(jobId);
            expect(got?.id).toBe(jobId);

            const listed = await jobsRepo.listByStatus('queued', 10, 0);
            expect(listed.find((j) => j.id === jobId)).toBeTruthy();

            const updated = await jobsRepo.update(jobId, { progress: 10 });
            expect(updated.progress).toBe(10);

            const processing = await jobsRepo.transition(jobId, 'processing', {
                type: 'status:processing',
                data: { step: 'claim' },
            });
            expect(processing.status).toBe('processing');

            const ts = new Date().toISOString();
            await eventsRepo.add({
                jobId,
                ts,
                type: 'progress',
                data: { pct: 10 },
            });
            const events = await eventsRepo.list(jobId, 10, 0);
            expect(events.length).toBeGreaterThan(0);
            if (events.length > 0) expect(events[0]!.jobId).toBe(jobId);

            // cleanup DB row to keep tests idempotent
            await db.delete(jobs).where(eq(jobs.id, jobId));
        });

        test('db repos: create job with youtube source_url is stored and retrievable', async () => {
            const db = createDb();
            const jobsRepo = new DrizzleJobsRepo(db);

            const jobId = crypto.randomUUID();
            const yt = 'https://www.youtube.com/watch?v=8tx2viHpgA8';
            const created = await jobsRepo.create({
                id: jobId,
                status: 'queued',
                progress: 0,
                sourceType: 'youtube',
                sourceUrl: yt,
                startSec: 0,
                endSec: 2,
                withSubtitles: false,
                burnSubtitles: false,
            });
            expect(created.id).toBe(jobId);
            expect(created.sourceType).toBe('youtube');
            expect(created.sourceUrl).toBe(yt);

            const got = await jobsRepo.get(jobId);
            expect(got?.sourceUrl).toBe(yt);

            // cleanup row
            await db.delete(jobs).where(eq(jobs.id, jobId));
        });

        test("cleanup job: dry-run returns items but doesn't delete", async () => {
            const db = createDb();
            const jobsRepo = new DrizzleJobsRepo(db);

            const jobId = crypto.randomUUID();
            const created = await jobsRepo.create({
                id: jobId,
                status: 'done',
                progress: 100,
                sourceType: 'upload',
                startSec: 0,
                endSec: 1,
                withSubtitles: false,
                burnSubtitles: false,
            });
            // expire it
            const past = new Date(Date.now() - 1000);
            await db
                .update(jobs)
                .set({ expiresAt: past })
                .where(eq(jobs.id, jobId));

            const res = await cleanupExpiredJobs({
                dryRun: true,
                batchSize: 10,
            });
            expect(res.scanned).toBeGreaterThan(0);
            const item = res.items.find((i) => i.jobId === jobId);
            expect(item).toBeTruthy();

            // should still exist
            const still = await jobsRepo.get(jobId);
            expect(still).not.toBeNull();

            // cleanup row for test hygiene
            await db.delete(jobs).where(eq(jobs.id, jobId));
        });

        test('cleanup job: deletes expired job from DB', async () => {
            const db = createDb();
            const jobsRepo = new DrizzleJobsRepo(db);

            const jobId = crypto.randomUUID();
            await jobsRepo.create({
                id: jobId,
                status: 'done',
                progress: 100,
                sourceType: 'upload',
                startSec: 0,
                endSec: 1,
                withSubtitles: false,
                burnSubtitles: false,
                resultSrtKey: `results/${jobId}/clip.srt`,
            });
            await db
                .update(jobs)
                .set({ expiresAt: new Date(Date.now() - 1000) })
                .where(eq(jobs.id, jobId));

            const res = await cleanupExpiredJobs({
                dryRun: false,
                batchSize: 10,
                storage: null,
            });
            expect(res.deletedJobs).toBeGreaterThan(0);
            const after = await jobsRepo.get(jobId);
            expect(after).toBeNull();
        });

        test('api keys: issue → verify → revoke', async () => {
            // Skip if Bun.password not available under this test runtime
            const bun: any = (globalThis as any).Bun;
            if (!bun?.password) return; // skip silently

            const repo = new DrizzleApiKeysRepo(createDb());
            const { id, name, token } = await repo.issue('test-key');
            expect(id).toBeTruthy();
            expect(name).toBe('test-key');

            const ok = await repo.verify(token);
            expect(ok?.id).toBe(id);

            await repo.revoke(id);
            const again = await repo.verify(token);
            expect(again).toBeNull();
        });

        // Manual, opt-in test to create a persistent job for visual verification in Supabase UI
        const persistJob = readEnv('PERSIST_TEST_JOB') === 'true';
        (persistJob ? test : test.skip)(
            'manual: create persistent youtube job (no cleanup — set PERSIST_TEST_JOB=true to run)',
            async () => {
                const db = createDb();
                const jobsRepo = new DrizzleJobsRepo(db);
                const jobId = crypto.randomUUID();
                const yt = 'https://www.youtube.com/watch?v=8tx2viHpgA8';
                const created = await jobsRepo.create({
                    id: jobId,
                    status: 'queued',
                    progress: 0,
                    sourceType: 'youtube',
                    sourceUrl: yt,
                    startSec: 0,
                    endSec: 2,
                    withSubtitles: false,
                    burnSubtitles: false,
                });
                // Print the job ID so you can find it in Supabase UI
                // eslint-disable-next-line no-console
                console.log('[PERSISTED_JOB]', { jobId: created.id, yt });
                expect(created.id).toBe(jobId);
            },
            30_000
        );
    } else {
        test.skip('DB tests skipped (DATABASE_URL missing)', () => {});
    }

    test('storage key builders are canonical', () => {
        const jobId = '1234';
        expect(storageKeys.source(jobId, 'mp4')).toBe(
            'sources/1234/source.mp4'
        );
        expect(storageKeys.source(jobId, '.mkv')).toBe(
            'sources/1234/source.mkv'
        );
        expect(storageKeys.resultVideo(jobId)).toBe('results/1234/clip.mp4');
        expect(storageKeys.resultSrt(jobId)).toBe('results/1234/clip.srt');
    });

    // Supabase storage integration: only requires core envs; auto-creates a temp bucket if missing
    if (hasSupabaseCore) {
        test('e2e: create → transition → events → sign URL', async () => {
            const db = createDb();
            const jobsRepo = new DrizzleJobsRepo(db);
            const eventsRepo = new DrizzleJobEventsRepo(db);

            const jobId = crypto.randomUUID();
            const tmp = `./tmp-${jobId}.srt`;
            const key = storageKeys.resultSrt(jobId);
            const supabase = createClient(
                SUPABASE_URL!,
                SUPABASE_SERVICE_ROLE_KEY!
            );
            const bucketName = SUPABASE_STORAGE_BUCKET ?? `ytc_test_${jobId}`;
            let createdBucket = false;
            if (!SUPABASE_STORAGE_BUCKET) {
                const { error } = await supabase.storage.createBucket(
                    bucketName,
                    { public: false }
                );
                if (error && !String(error.message).includes('already exists'))
                    throw new Error(error.message);
                createdBucket = true;
            }

            // create job
            await jobsRepo.create({
                id: jobId,
                status: 'queued',
                progress: 0,
                sourceType: 'upload',
                startSec: 0,
                endSec: 2,
                withSubtitles: false,
                burnSubtitles: false,
                resultSrtKey: key,
            });

            // transition + event
            await jobsRepo.transition(jobId, 'processing', {
                type: 'status:processing',
                data: { step: 'claim' },
            });
            await eventsRepo.add({
                jobId,
                ts: new Date().toISOString(),
                type: 'progress',
                data: { pct: 5 },
            });

            // upload artifact then sign
            const bun: any = (globalThis as any).Bun;
            if (bun?.write) {
                await bun.write(tmp, '1\n00:00:00,000 --> 00:00:00,500\nHello');
            } else {
                await writeFile(
                    tmp,
                    '1\n00:00:00,000 --> 00:00:00,500\nHello',
                    'utf8'
                );
            }
            const repo = createSupabaseStorageRepo({ bucket: bucketName });
            await repo.upload(tmp, key, 'application/x-subrip');
            const url = await repo.sign(key, 60);
            expect(typeof url).toBe('string');

            await unlink(tmp).catch(() => void 0);
            await repo.remove(key).catch(() => void 0);
            await db.delete(jobs).where(eq(jobs.id, jobId));
            if (createdBucket) {
                await supabase.storage
                    .emptyBucket(bucketName)
                    .catch(() => void 0);
                await supabase.storage
                    .deleteBucket(bucketName)
                    .catch(() => void 0);
            }
        }, 60_000);
        test('storage repo: upload, sign, remove (cleanup after)', async () => {
            const jobId = crypto.randomUUID();
            const key = storageKeys.resultSrt(jobId);
            const tmp = `./tmp-${jobId}.srt`;

            const supabase = createClient(
                SUPABASE_URL!,
                SUPABASE_SERVICE_ROLE_KEY!
            );
            const bucketName = SUPABASE_STORAGE_BUCKET ?? `ytc_test_${jobId}`;
            let createdBucket = false;
            if (!SUPABASE_STORAGE_BUCKET) {
                const { error } = await supabase.storage.createBucket(
                    bucketName,
                    {
                        public: false,
                    }
                );
                if (
                    error &&
                    !String(error.message).includes('already exists')
                ) {
                    throw new Error(`createBucket failed: ${error.message}`);
                }
                createdBucket = true;
            }

            const bun: any = (globalThis as any).Bun;
            if (bun?.write) {
                await bun.write(tmp, '1\n00:00:00,000 --> 00:00:00,500\nHello');
            } else {
                await writeFile(
                    tmp,
                    '1\n00:00:00,000 --> 00:00:00,500\nHello',
                    'utf8'
                );
            }

            const repo = createSupabaseStorageRepo({ bucket: bucketName });
            try {
                await repo.upload(tmp, key, 'application/x-subrip');
                const url = await repo.sign(key, 60);
                expect(typeof url).toBe('string');
            } finally {
                await repo.remove(key).catch(() => void 0);
                await unlink(tmp).catch(() => void 0);
                if (createdBucket) {
                    await supabase.storage
                        .emptyBucket(bucketName)
                        .catch(() => void 0);
                    await supabase.storage
                        .deleteBucket(bucketName)
                        .catch(() => void 0);
                }
            }
        }, 60_000);

        test('cleanup job: removes storage objects when configured', async () => {
            const jobId = crypto.randomUUID();
            const tmp = `./tmp-${jobId}.srt`;
            const key = storageKeys.resultSrt(jobId);
            const supabase = createClient(
                SUPABASE_URL!,
                SUPABASE_SERVICE_ROLE_KEY!
            );
            const bucketName = SUPABASE_STORAGE_BUCKET ?? `ytc_test_${jobId}`;
            let createdBucket = false;
            if (!SUPABASE_STORAGE_BUCKET) {
                const { error } = await supabase.storage.createBucket(
                    bucketName,
                    { public: false }
                );
                if (error && !String(error.message).includes('already exists'))
                    throw new Error(error.message);
                createdBucket = true;
            }

            // upload a file via repo
            const bun: any = (globalThis as any).Bun;
            if (bun?.write) {
                await bun.write(tmp, '1\n00:00:00,000 --> 00:00:00,500\nHello');
            } else {
                await writeFile(
                    tmp,
                    '1\n00:00:00,000 --> 00:00:00,500\nHello',
                    'utf8'
                );
            }
            const repo = createSupabaseStorageRepo({ bucket: bucketName });
            await repo.upload(tmp, key, 'application/x-subrip');

            // create an expired job referencing the object
            const db = createDb();
            const jobsRepo = new DrizzleJobsRepo(db);
            await jobsRepo.create({
                id: jobId,
                status: 'done',
                progress: 100,
                sourceType: 'upload',
                startSec: 0,
                endSec: 1,
                withSubtitles: false,
                burnSubtitles: false,
                resultSrtKey: key,
            });
            await db
                .update(jobs)
                .set({ expiresAt: new Date(Date.now() - 1000) })
                .where(eq(jobs.id, jobId));

            const res = await cleanupExpiredJobs({
                dryRun: false,
                batchSize: 10,
                storage: repo,
            });
            expect(res.deletedJobs).toBe(1);
            // verify object removed by attempting to sign (should fail)
            await expect(repo.sign(key, 60)).rejects.toThrow();

            await unlink(tmp).catch(() => void 0);
            if (createdBucket) {
                await supabase.storage
                    .emptyBucket(bucketName)
                    .catch(() => void 0);
                await supabase.storage
                    .deleteBucket(bucketName)
                    .catch(() => void 0);
            }
        }, 60_000);
    } else {
        test.skip(`Supabase storage tests skipped; missing env: ${missingSupabaseCore.join(
            ', '
        )}`, () => {});
    }

    // Smoke test for storage bootstrap script
    const hasBucket = !!SUPABASE_STORAGE_BUCKET;
    if (hasSupabaseCore && hasBucket) {
        test('storage bootstrap script runs', async () => {
            const { bootstrapStorage } = await import(
                '../scripts/bootstrap-storage'
            );
            await bootstrapStorage({
                bucket: SUPABASE_STORAGE_BUCKET!,
                createPrefixes: true,
            });
            expect(true).toBe(true);
        }, 30_000);
    } else {
        test.skip('storage bootstrap skipped (missing SUPABASE_STORAGE_BUCKET or core envs)', () => {});
    }
});
