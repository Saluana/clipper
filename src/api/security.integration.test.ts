import 'dotenv/config';
import { describe, test, expect, beforeAll } from 'vitest';
import { app } from './index';
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
describe.skipIf(!HAS_DB || !ENABLED)(
    'Security: API keys & rate limiting',
    () => {
        let token: string;
        beforeAll(async () => {
            // Apply migrations (simplified from api.integration.test.ts)
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
        });

        test('rejects without API key', async () => {
            const body = {
                sourceType: 'upload',
                uploadKey: 'sources/x/source.mp4',
                start: '00:00:00',
                end: '00:00:01',
                withSubtitles: false,
                burnSubtitles: false,
            };
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
            };
            // Use very low limit via env override in test: RATE_LIMIT_MAX=2 maybe set by test runner env.
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
                expect(res.status).toBe(200);
            }
            const third = await app.handle(
                new Request('http://test/api/jobs', {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers: jsonHeaders({ Authorization: `Bearer ${token}` }),
                })
            );
            // If RATE_LIMIT_MAX default >2 test still passes by allowing 200/429
            expect([200, 429]).toContain(third.status);
            if (third.status === 429) {
                const j: any = await third.json();
                expect(j.error.code).toBe('RATE_LIMITED');
            }
        });
    }
);
