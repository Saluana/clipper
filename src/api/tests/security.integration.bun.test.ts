import 'dotenv/config';
import { describe, test, expect, beforeAll } from 'bun:test';
import { app } from '../index';
import { DrizzleApiKeysRepo, createDb } from '@clipper/data';
import { Pool } from 'pg';
import { readdir, readFile } from 'node:fs/promises';

const HAS_DB = !!process.env.DATABASE_URL;
const ENABLED =
    (process.env.ENABLE_API_KEYS || 'false').toLowerCase() === 'true';

function jsonHeaders(extra: Record<string, string> = {}) {
    return { 'content-type': 'application/json', ...extra };
}

// Only run when DB present and feature enabled
(HAS_DB && ENABLED ? describe : describe.skip)(
    'Security: API keys & rate limiting',
    () => {
        let token: string;
        let token2: string; // second key for isolation
        beforeAll(async () => {
            const pool = new Pool({
                connectionString: process.env.DATABASE_URL,
            });
            try {
                const { rows } = await pool.query(
                    "SELECT to_regclass('public.jobs') as rel"
                );
                const jobsExists = !!rows[0]?.rel;
                if (!jobsExists) {
                    const migrationsFolder = new URL(
                        '../data/drizzle',
                        import.meta.url
                    ).pathname;
                    const files = (await readdir(migrationsFolder))
                        .filter((f) => /\.sql$/.test(f))
                        .sort();
                    for (const file of files) {
                        const raw = await readFile(
                            `${migrationsFolder}/${file}`,
                            'utf8'
                        );
                        const normalized = raw.replace(
                            /-->\s*statement-breakpoint/g,
                            ';'
                        );
                        const statements = normalized
                            .split(/;\s*(?:\n|$)/g)
                            .map((s) => s.trim())
                            .filter(
                                (s) =>
                                    s.length &&
                                    !s.startsWith('--') &&
                                    !s.startsWith('/*')
                            );
                        for (const stmt of statements) {
                            try {
                                await pool.query(stmt);
                            } catch (e: any) {
                                const code = e?.code;
                                const msg = String(
                                    e?.message || ''
                                ).toLowerCase();
                                if (
                                    [
                                        '42710',
                                        '42p07',
                                        '42701',
                                        '42p16',
                                    ].includes(String(code).toLowerCase()) ||
                                    msg.includes('already exists') ||
                                    msg.includes('duplicate')
                                )
                                    continue;
                                throw e;
                            }
                        }
                    }
                }
            } finally {
                await pool.end();
            }
            const repo = new DrizzleApiKeysRepo(createDb());
            const issued = await repo.issue('test');
            token = issued.token;
            const issued2 = await repo.issue('test2');
            token2 = issued2.token;
        });

        test('rejects without API key', async () => {
            const body = {
                sourceType: 'upload',
                uploadKey: 'sources/x/source.mp4',
                start: '00:00:00',
                end: '00:00:01',
                withSubtitles: false,
                burnSubtitles: false,
            } as any;
            const res = await app.handle(
                new Request('http://test/api/jobs', {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers: jsonHeaders(),
                })
            );
            expect(res.status).toBe(401);
            const json: any = await res.json();
            expect(json.error.code).toBe('UNAUTHORIZED');
        });

        test('accepts with valid API key then rate limits', async () => {
            const body = {
                sourceType: 'upload',
                uploadKey: 'sources/x/source.mp4',
                start: '00:00:00',
                end: '00:00:01',
                withSubtitles: false,
                burnSubtitles: false,
            } as any;
            for (let i = 0; i < 2; i++) {
                const res = await app.handle(
                    new Request('http://test/api/jobs', {
                        method: 'POST',
                        body: JSON.stringify(body),
                        headers: jsonHeaders({
                            Authorization: `Bearer ${token}`,
                        }),
                    })
                );
                expect([200, 429]).toContain(res.status);
                if (res.status === 429) return; // already limited early
            }
            const third = await app.handle(
                new Request('http://test/api/jobs', {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers: jsonHeaders({ Authorization: `Bearer ${token}` }),
                })
            );
            expect([200, 429]).toContain(third.status);
            if (third.status === 429) {
                const j: any = await third.json();
                expect(j.error.code).toBe('RATE_LIMITED');
            }
        });

        test('GET status unauthorized without key & authorized with key', async () => {
            // Create a job with key
            const body = {
                sourceType: 'upload',
                uploadKey: 'sources/x/source.mp4',
                start: '00:00:00',
                end: '00:00:01',
                withSubtitles: false,
                burnSubtitles: false,
            } as any;
            const createdRes = await app.handle(
                new Request('http://test/api/jobs', {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers: jsonHeaders({ Authorization: `Bearer ${token}` }),
                })
            );
            expect([200, 429]).toContain(createdRes.status);
            if (createdRes.status === 429) {
                // If rate limited immediately, wait for window to proceed for remaining assertions
                await new Promise((r) =>
                    setTimeout(
                        r,
                        Number(process.env.RATE_LIMIT_WINDOW_SEC || '2') *
                            1000 +
                            50
                    )
                );
                const retryRes = await app.handle(
                    new Request('http://test/api/jobs', {
                        method: 'POST',
                        body: JSON.stringify(body),
                        headers: jsonHeaders({
                            Authorization: `Bearer ${token}`,
                        }),
                    })
                );
                expect(retryRes.status).toBe(200);
                const retryJson: any = await retryRes.json();
                const jobId = retryJson.job.id;
                // Unauthorized fetch
                const noAuth = await app.handle(
                    new Request(`http://test/api/jobs/${jobId}`, {
                        method: 'GET',
                    })
                );
                expect(noAuth.status).toBe(401);
                const auth = await app.handle(
                    new Request(`http://test/api/jobs/${jobId}`, {
                        method: 'GET',
                        headers: { Authorization: `Bearer ${token}` },
                    })
                );
                expect(auth.status).toBe(200);
                const statusJson: any = await auth.json();
                expect(statusJson.job.id).toBe(jobId);
                return; // finished alternate path
            }
            const createdJson: any = await createdRes.json();
            const jobId = createdJson.job.id;

            // Unauthorized fetch
            const noAuth = await app.handle(
                new Request(`http://test/api/jobs/${jobId}`, { method: 'GET' })
            );
            expect(noAuth.status).toBe(401);

            // Authorized fetch
            const auth = await app.handle(
                new Request(`http://test/api/jobs/${jobId}`, {
                    method: 'GET',
                    headers: { Authorization: `Bearer ${token}` },
                })
            );
            expect(auth.status).toBe(200);
            const statusJson: any = await auth.json();
            expect(statusJson.job.id).toBe(jobId);
        });

        test('invalid token is rejected (malformed + unknown)', async () => {
            const body = {
                sourceType: 'upload',
                uploadKey: 'sources/x/source.mp4',
                start: '00:00:00',
                end: '00:00:01',
                withSubtitles: false,
                burnSubtitles: false,
            } as any;
            // Malformed
            const malformed = await app.handle(
                new Request('http://test/api/jobs', {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers: jsonHeaders({ Authorization: 'Bearer not_a_key' }),
                })
            );
            expect(malformed.status).toBe(401);
            // Well-formed but unknown (simulate by tweaking one char of real token)
            const parts = token.split('_');
            const unknown =
                parts.length > 2
                    ? `${parts[0]}_${parts[1]}_${parts[2]}x`
                    : token + 'x';
            const unknownRes = await app.handle(
                new Request('http://test/api/jobs', {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers: jsonHeaders({
                        Authorization: `Bearer ${unknown}`,
                    }),
                })
            );
            expect(unknownRes.status).toBe(401);
        });

        test('rate limiting isolated per API key', async () => {
            // Use tight limit environment (caller should run with RATE_LIMIT_MAX=1)
            const body = {
                sourceType: 'upload',
                uploadKey: 'sources/x/source.mp4',
                start: '00:00:00',
                end: '00:00:01',
                withSubtitles: false,
                burnSubtitles: false,
            } as any;
            // First key consumes its allowance
            const first = await app.handle(
                new Request('http://test/api/jobs', {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers: jsonHeaders({ Authorization: `Bearer ${token}` }),
                })
            );
            expect([200, 429]).toContain(first.status);
            const second = await app.handle(
                new Request('http://test/api/jobs', {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers: jsonHeaders({ Authorization: `Bearer ${token}` }),
                })
            );
            // If limit is 1, second likely 429
            if (Number(process.env.RATE_LIMIT_MAX || '30') <= 1) {
                expect(second.status).toBe(429);
            }
            // Second key should still succeed at least once even if first got limited
            const other = await app.handle(
                new Request('http://test/api/jobs', {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers: jsonHeaders({ Authorization: `Bearer ${token2}` }),
                })
            );
            expect([200, 429]).toContain(other.status);
            if (Number(process.env.RATE_LIMIT_MAX || '30') <= 1) {
                expect(other.status).toBe(200); // independence
            }
        });

        test('rate limit window resets (wait for window)', async () => {
            const max = Number(process.env.RATE_LIMIT_MAX || '30');
            const windowSec = Number(process.env.RATE_LIMIT_WINDOW_SEC || '60');
            if (max > 2 || windowSec > 3) return; // skip long wait in default config
            const body = {
                sourceType: 'upload',
                uploadKey: 'sources/x/source.mp4',
                start: '00:00:00',
                end: '00:00:01',
                withSubtitles: false,
                burnSubtitles: false,
            } as any;
            // Exhaust
            const a = await app.handle(
                new Request('http://test/api/jobs', {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers: jsonHeaders({ Authorization: `Bearer ${token}` }),
                })
            );
            expect([200, 429]).toContain(a.status);
            for (let i = 1; i < max; i++) {
                await app.handle(
                    new Request('http://test/api/jobs', {
                        method: 'POST',
                        body: JSON.stringify(body),
                        headers: jsonHeaders({
                            Authorization: `Bearer ${token}`,
                        }),
                    })
                );
            }
            const hit = await app.handle(
                new Request('http://test/api/jobs', {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers: jsonHeaders({ Authorization: `Bearer ${token}` }),
                })
            );
            expect([200, 429]).toContain(hit.status);
            // Wait for window + small buffer
            await new Promise((r) => setTimeout(r, windowSec * 1000 + 120));
            const after = await app.handle(
                new Request('http://test/api/jobs', {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers: jsonHeaders({ Authorization: `Bearer ${token}` }),
                })
            );
            expect(after.status).toBe(200);
        });
    }
);
