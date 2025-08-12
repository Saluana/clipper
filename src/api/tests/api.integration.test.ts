import 'dotenv/config';
import { describe, test, expect, beforeAll } from 'vitest';
import { app } from '../index';
import { createDb } from '@clipper/data';
import { Pool } from 'pg';
import { readdir, readFile } from 'node:fs/promises';

// Basic integration tests for new API endpoints.
// Skips automatically if DATABASE_URL not provided (requires real Postgres + pg-boss).

const HAS_DB = !!process.env.DATABASE_URL;

function jsonHeaders(extra: Record<string, string> = {}) {
    return { 'content-type': 'application/json', ...extra };
}

describe.skipIf(!HAS_DB)('API core endpoints', () => {
    // Apply migrations once
    beforeAll(async () => {
        const pool = new Pool({ connectionString: process.env.DATABASE_URL });
        try {
            // Does jobs table exist?
            const { rows } = await pool.query(
                "SELECT to_regclass('public.jobs') as rel"
            );
            const jobsExists = !!rows[0]?.rel;
            if (!jobsExists) {
                // Apply full migrations (simple sequential execution) only once.
                const migrationsFolder = new URL(
                    '../data/drizzle',
                    import.meta.url
                ).pathname;
                const files = (await readdir(migrationsFolder))
                    .filter((f) => /\\.sql$/.test(f))
                    .sort();
                for (const file of files) {
                    const raw = await readFile(
                        `${migrationsFolder}/${file}`,
                        'utf8'
                    );
                    // Normalize drizzle statement breakpoints into semicolons
                    const normalized = raw.replace(
                        /-->\s*statement-breakpoint/g,
                        ';'
                    );
                    const statements = normalized
                        .split(/;\s*(?:\n|$)/g)
                        .map((s) => s.trim())
                        .filter(
                            (s) =>
                                s.length > 0 &&
                                !s.startsWith('--') &&
                                !s.startsWith('/*')
                        );
                    for (const stmt of statements) {
                        try {
                            await pool.query(stmt);
                        } catch (e: any) {
                            const code = e?.code;
                            const msg = String(e?.message || e).toLowerCase();
                            if (
                                [
                                    '42710', // duplicate object
                                    '42p07', // duplicate table
                                    '42701', // duplicate column
                                    '42p16', // existing constraint variations
                                ].includes(String(code).toLowerCase()) ||
                                msg.includes('already exists') ||
                                msg.includes('duplicate')
                            ) {
                                continue;
                            }
                            throw e;
                        }
                    }
                }
            }
            // Ensure last_heartbeat_at column exists (newer migration) idempotently
            try {
                await pool.query(
                    'ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "last_heartbeat_at" timestamptz'
                );
            } catch (e) {
                // ignore
            }
            // Ensure indexes (idempotent) - IF NOT EXISTS supported for indexes
            await pool.query(
                'CREATE INDEX IF NOT EXISTS "idx_jobs_expires_at" ON "jobs" ("expires_at")'
            );
        } finally {
            await pool.end();
        }
    });

    test('POST /api/jobs -> create then GET /api/jobs/:id', async () => {
        const reqId = crypto.randomUUID();
        const body = {
            sourceType: 'upload',
            uploadKey: 'sources/demo/source.mp4',
            start: '00:00:00',
            end: '00:00:05',
            withSubtitles: false,
            burnSubtitles: false,
        };
        const createRes = await app.handle(
            new Request('http://test/api/jobs', {
                method: 'POST',
                body: JSON.stringify(body),
                headers: jsonHeaders({ 'x-request-id': reqId }),
            })
        );
        if (createRes.status !== 200) {
            const errBody = await createRes.text();
            throw new Error(
                `create job failed status=${createRes.status} body=${errBody}`
            );
        }
        expect(createRes.status).toBe(200);
        const created = (await createRes.json()) as any;
        expect(created.correlationId).toBe(reqId);
        expect(created.job).toBeTruthy();
        expect(created.job.id).toMatch(/[-0-9a-f]{36}/);
        expect(created.job.status).toBe('queued');
        const jobId = created.job.id;

        // GET status
        const statusRes = await app.handle(
            new Request(`http://test/api/jobs/${jobId}`, {
                headers: { 'x-request-id': reqId },
            })
        );
        expect(statusRes.status).toBe(200);
        const statusJson = (await statusRes.json()) as any;
        expect(statusJson.correlationId).toBe(reqId);
        expect(statusJson.job.id).toBe(jobId);
        expect(statusJson.job.progress).toBeTypeOf('number');
        expect(Array.isArray(statusJson.events)).toBe(true);

        // Result not ready yet
        const resultRes = await app.handle(
            new Request(`http://test/api/jobs/${jobId}/result`, {
                headers: { 'x-request-id': reqId },
            })
        );
        // Expect 404 NOT_READY until worker finishes
        if (resultRes.status !== 404) {
            // If test environment has a fast worker it might already be done; allow 200
            expect([200, 404]).toContain(resultRes.status);
        } else {
            const resultJson = (await resultRes.json()) as any;
            expect(resultJson.error.code).toBe('NOT_READY');
            expect(resultJson.error.correlationId).toBe(reqId);
        }
    }, 20_000);

    test('GET /api/jobs/:id 404', async () => {
        const reqId = crypto.randomUUID();
        const resp = await app.handle(
            new Request(
                'http://test/api/jobs/00000000-0000-4000-8000-000000000000',
                {
                    headers: { 'x-request-id': reqId },
                }
            )
        );
        if (resp.status !== 404) {
            const body = await resp.text();
            throw new Error(`expected 404 got ${resp.status} body=${body}`);
        }
        expect(resp.status).toBe(404);
        const json = (await resp.json()) as any;
        expect(json.error.code).toBe('NOT_FOUND');
        expect(json.error.correlationId).toBe(reqId);
    });
});
