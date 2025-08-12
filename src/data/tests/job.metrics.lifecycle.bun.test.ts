import { test, expect } from 'bun:test';
import { DrizzleJobsRepo, DrizzleJobEventsRepo } from '../db/repos';
import { createDb } from '../db/connection';
import { InMemoryMetrics } from '../../common/metrics';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readEnv } from '../../common/env';
import { Pool } from 'pg';

const baseUrl = readEnv('DATABASE_URL');
const hasDb = !!baseUrl;

// Helper to extract single counter value by prefix match
function counterVal(
    counters: Record<string, number>,
    name: string,
    labels?: Record<string, string>
) {
    if (labels) {
        const suffix = Object.entries(labels)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join(',');
        const key = `${name}{${suffix}}`;
        return counters[key] ?? 0;
    }
    // find exact no-label key
    return counters[name] ?? 0;
}

test(
    hasDb
        ? 'job lifecycle metrics: create -> processing -> done'
        : 'skip job lifecycle metrics (no db)',
    async () => {
        if (!hasDb) return; // skip
        // Create isolated schema to avoid enum/type collisions on repeated runs
        const schemaName =
            't_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
        const url =
            baseUrl +
            (baseUrl!.includes('?')
                ? `&search_path=${schemaName}`
                : `?search_path=${schemaName}`);
        // Ensure schema exists
        const pool = new Pool({ connectionString: baseUrl });
        await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}";`);
        pool.end();
        const db = createDb(url);
        await migrate(db, {
            migrationsFolder: new URL('../drizzle', import.meta.url).pathname,
        });
        const metrics = new InMemoryMetrics();
        const jobs = new DrizzleJobsRepo(db, metrics);
        const events = new DrizzleJobEventsRepo(db, metrics);

        const id = crypto.randomUUID();
        const created = await jobs.create({
            id,
            status: 'queued',
            progress: 0,
            sourceType: 'upload',
            startSec: 0,
            endSec: 1,
            withSubtitles: false,
            burnSubtitles: false,
        } as any);
        expect(created.id).toBe(id);
        // created_total incremented
        let snap = metrics.snapshot();
        expect(snap.counters['jobs.created_total']).toBe(1);

        // transition queued -> processing
        await jobs.update(id, { status: 'processing' } as any);
        snap = metrics.snapshot();
        // status transition metric present
        const transKey = Object.keys(snap.counters).find((k) =>
            k.startsWith('jobs.status_transition_total{')
        );
        expect(transKey).toBeTruthy();
        // transition from queued to processing count 1
        expect(
            snap.counters[
                'jobs.status_transition_total{from=queued,to=processing}'
            ]
        ).toBe(1);

        // simulate some work then mark done
        await new Promise((r) => setTimeout(r, 5));
        await jobs.update(id, { status: 'done', progress: 100 } as any);
        snap = metrics.snapshot();
        expect(
            snap.counters[
                'jobs.status_transition_total{from=processing,to=done}'
            ]
        ).toBe(1);

        // latency histogram recorded
        const hist = snap.histograms['jobs.total_latency_ms'];
        expect(hist?.count ?? 0).toBeGreaterThan(0);
        expect(hist?.sum ?? 0).toBeGreaterThan(0);
    }
);
