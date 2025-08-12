import 'dotenv/config';
import { describe, test, expect, beforeAll } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from '../db/connection';
import { DrizzleAsrJobsRepo, DrizzleAsrArtifactsRepo } from '../db/repos';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';

// Fail fast if env not loaded
if (!process.env.DATABASE_URL) {
    throw new Error(
        'DATABASE_URL missing for ASR repo tests. Add it to your .env so integration tests run instead of being skipped.'
    );
}

describe('ASR Repos (Drizzle)', () => {
    beforeAll(async () => {
        const db = createDb();
        let asrExists = true;
        try {
            await db.execute(sql`select 1 from "asr_jobs" limit 1`);
        } catch (e: any) {
            if (e?.code === '42P01' || /asr_jobs/.test(String(e?.message))) {
                asrExists = false;
            } else throw e;
        }

        if (!asrExists) {
            // Determine if base migrations already applied (jobs table exists)
            let jobsExists = true;
            try {
                await db.execute(sql`select 1 from "jobs" limit 1`);
            } catch (e: any) {
                if (e?.code === '42P01') jobsExists = false;
            }
            if (!jobsExists) {
                // Fresh DB: run full migrator (will apply 0000 then 0001)
                const migrationsFolder = new URL('../drizzle', import.meta.url)
                    .pathname;
                try {
                    await migrate(db, { migrationsFolder });
                } catch (err: any) {
                    if (!/already exists/.test(String(err?.message))) throw err;
                }
            } else {
                // Base schema present; apply only 0001 manually to avoid re-running 0000
                const file = new URL(
                    '../drizzle/0001_asr_jobs.sql',
                    import.meta.url
                ).pathname;
                const sqlText = readFileSync(file, 'utf8');
                // naive split on ; with trimming (works for our simple migration file)
                const statements = sqlText
                    .split(/;\s*\n/)
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0);
                for (const stmt of statements) {
                    try {
                        await db.execute(sql.raw(stmt));
                    } catch (err: any) {
                        if (!/already exists/.test(String(err?.message)))
                            throw err;
                    }
                }
            }
        }
    });

    test('create → get → patch → artifacts → reuse', async () => {
        const jobsRepo = new DrizzleAsrJobsRepo();
        const artifactsRepo = new DrizzleAsrArtifactsRepo();
        const id = crypto.randomUUID();
        const mediaHash =
            'hash_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        const modelVersion = 'whisper-large-v3-turbo';

        const created = await jobsRepo.create({
            id,
            sourceType: 'upload',
            mediaHash,
            modelVersion,
        });
        expect(created.id).toBe(id);
        expect(created.status).toBe('queued');

        const patched = await jobsRepo.patch(id, { status: 'processing' });
        expect(patched.status).toBe('processing');

        // add artifact
        await artifactsRepo.put({
            asrJobId: id,
            kind: 'srt',
            storageKey: `results/${id}/transcript/clip.srt`,
            sizeBytes: 123,
            createdAt: new Date().toISOString(),
        });

        // mark done
        await jobsRepo.patch(id, {
            status: 'done',
            detectedLanguage: 'en',
            durationSec: 5,
        });

        const reuse = await jobsRepo.getReusable(mediaHash, modelVersion);
        expect(reuse).not.toBeNull();
        if (reuse) {
            expect(reuse.artifacts.length).toBeGreaterThan(0);
            expect(reuse.artifacts[0]!.kind).toBe('srt');
        }
    });
});
