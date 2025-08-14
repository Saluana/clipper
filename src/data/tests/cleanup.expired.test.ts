import 'dotenv/config';
import { test, expect } from 'vitest';
import { cleanupExpiredJobs } from '../cleanup';
import { createDb } from '../db/connection';
import { jobs, type NewJob } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import { storageKeys } from '../storage';
import { readFileSync } from 'node:fs';

if (!process.env.DATABASE_URL) {
    throw new Error(
        'DATABASE_URL missing for cleanup.expired.test. Add it to your .env to run integration tests.'
    );
}

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

async function ensureSchema() {
    const db = createDb();
    // Detect jobs table
    let jobsExists = true;
    try {
        await db.execute(sql`select 1 from "jobs" limit 1`);
    } catch (e: any) {
        if (e?.code === '42P01') jobsExists = false;
        else throw e;
    }
    if (!jobsExists) {
        // Fresh DB: run full 0000 migration file manually (avoid migrator double-run issues)
        const file = new URL(
            '../../data/drizzle/0000_tense_yellow_claw.sql',
            import.meta.url
        ).pathname;
        const sqlText = readFileSync(file, 'utf8');
        const statements = sqlText
            .split(/;\s*\n/)
            .map((s) => s.trim())
            .filter((s) => s.length);
        for (const stmt of statements) {
            try {
                await db.execute(sql.raw(stmt));
            } catch (err: any) {
                if (!/already exists/.test(String(err?.message))) throw err;
            }
        }
    }
    // Ensure ASR migration not needed here (only jobs table required) but safe to apply 0001 if present and not applied
    let asrExists = true;
    try {
        await db.execute(sql`select 1 from "asr_jobs" limit 1`);
    } catch (e: any) {
        if (e?.code === '42P01') asrExists = false;
        else throw e;
    }
    if (!asrExists) {
        const file = new URL(
            '../../data/drizzle/0001_asr_jobs.sql',
            import.meta.url
        ).pathname;
        const sqlText = readFileSync(file, 'utf8');
        const statements = sqlText
            .split(/;\s*\n/)
            .map((s) => s.trim())
            .filter((s) => s.length);
        for (const stmt of statements) {
            try {
                await db.execute(sql.raw(stmt));
            } catch (err: any) {
                if (!/already exists/.test(String(err?.message))) throw err;
            }
        }
    }
}

test('cleanup removes expired job objects', async () => {
    await ensureSchema();
    const db = createDb();
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

test('cleanup also removes burned video artifact when present', async () => {
    await ensureSchema();
    const db = createDb();
    const jobId = crypto.randomUUID();
    const videoKey = storageKeys.resultVideo(jobId);
    const burnedKey = storageKeys.resultVideoBurned(jobId);
    const srtKey = storageKeys.resultSrt(jobId);
    const row: NewJob = {
        id: jobId,
        status: 'done',
        progress: 100,
        sourceType: 'upload',
        startSec: 0,
        endSec: 1,
        withSubtitles: true,
        burnSubtitles: true,
        resultVideoKey: videoKey,
        // burned key persisted in the same row
        resultVideoBurnedKey: burnedKey as any,
        resultSrtKey: srtKey,
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() - 1000),
    } as any;
    await db.insert(jobs).values(row);
    const storage = new MemoryStorage();
    const res = await cleanupExpiredJobs({ dryRun: false, storage });
    expect(res.deletedJobs).toBeGreaterThanOrEqual(1);
    expect(storage.removed).toEqual(
        expect.arrayContaining([videoKey, burnedKey, srtKey])
    );
});
