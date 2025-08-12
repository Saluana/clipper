import 'dotenv/config';
import { test, expect } from 'vitest';
import { cleanupExpiredAsrJobs } from '../cleanup';
import { createDb } from '../db/connection';
import {
    asrJobs,
    asrArtifacts,
    type NewAsrJob,
    type NewAsrArtifact,
} from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';

if (!process.env.DATABASE_URL) {
    throw new Error(
        'DATABASE_URL missing for cleanup.asr.expired.test. Add it to your .env to run integration tests.'
    );
}

class MemoryStorage {
    removed: string[] = [];
    async remove(key: string) {
        this.removed.push(key);
    }
    async upload() {}
    async sign() {
        return '';
    }
    async download() {
        return '/tmp/fake';
    }
}

async function ensureSchema() {
    const db = createDb();
    // Ensure base jobs (0000)
    let jobsExists = true;
    try {
        await db.execute(sql`select 1 from "jobs" limit 1`);
    } catch (e: any) {
        if (e?.code === '42P01') jobsExists = false;
        else throw e;
    }
    if (!jobsExists) {
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
    // Ensure ASR (0001)
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

test('cleanup removes expired ASR job + artifacts objects', async () => {
    await ensureSchema();
    const db = createDb();

    // Insert expired ASR job
    const asrJobId = crypto.randomUUID();
    const job: NewAsrJob = {
        id: asrJobId,
        clipJobId: null as any,
        sourceType: 'internal',
        sourceKey: null as any,
        mediaHash: 'hash-' + asrJobId,
        modelVersion: 'v1',
        languageHint: null as any,
        detectedLanguage: null as any,
        durationSec: 10,
        status: 'done',
        errorCode: null as any,
        errorMessage: null as any,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: new Date(),
        expiresAt: new Date(Date.now() - 1000),
    } as any;
    await db.insert(asrJobs).values(job);

    // Insert artifacts
    const srtKey = `results/${asrJobId}/transcript/clip.srt`;
    const txtKey = `results/${asrJobId}/transcript/clip.txt`;
    const art1: NewAsrArtifact = {
        asrJobId,
        kind: 'srt',
        storageKey: srtKey,
        sizeBytes: 123,
        createdAt: new Date(),
    } as any;
    const art2: NewAsrArtifact = {
        asrJobId,
        kind: 'text',
        storageKey: txtKey,
        sizeBytes: 77,
        createdAt: new Date(),
    } as any;
    await db.insert(asrArtifacts).values([art1, art2]);

    const storage = new MemoryStorage();
    const res = await cleanupExpiredAsrJobs({ dryRun: false, storage });

    expect(res.deletedAsrJobs).toBeGreaterThanOrEqual(1);
    expect(storage.removed).toEqual(expect.arrayContaining([srtKey, txtKey]));
    const remainingJobs = await db
        .select()
        .from(asrJobs)
        .where(eq(asrJobs.id, asrJobId));
    expect(remainingJobs.length).toBe(0);
    const remainingArtifacts = await db
        .select()
        .from(asrArtifacts)
        .where(eq(asrArtifacts.asrJobId, asrJobId));
    expect(remainingArtifacts.length).toBe(0); // cascade delete
});
