import { test, expect } from 'bun:test';
import { createDb } from '@clipper/data';
import { __test as workerTest } from './index';
import { readEnv } from '@clipper/common';

// Provide dummy DATABASE_URL if not present (drizzle connection will attempt to connect; we skip real DB ops by mocking updater)
if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/testdb';
}

// Utility to wait
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('heartbeat loop updates metrics for active jobs', async () => {
    const ids = ['job-a', 'job-b'];
    ids.forEach((id) => workerTest.activeJobs.add(id));
    let updateCalls: { ids: string[]; at: Date }[] = [];
    const stop = workerTest.startHeartbeatLoop({
        intervalMs: 30,
        updater: async (ids, now) => {
            updateCalls.push({ ids: [...ids], at: now });
        },
    });
    await sleep(120); // allow a few intervals
    stop();
    ids.forEach((id) => workerTest.activeJobs.delete(id));
    const snap = workerTest.metrics.snapshot();
    const hbCount = Object.entries(snap.counters)
        .filter(([k]) => k.startsWith('worker.heartbeats_total'))
        .reduce((a, [, v]) => a + v, 0);
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);
    expect(hbCount).toBeGreaterThanOrEqual(2);
    // Each update should include both job IDs
    for (const c of updateCalls) expect(c.ids.sort()).toEqual(ids);
});

test('heartbeat loop emits degraded warning after >3 consecutive failures', async () => {
    const id = 'job-x';
    workerTest.activeJobs.add(id);
    let warnTriggered = 0;
    const stop = workerTest.startHeartbeatLoop({
        intervalMs: 10,
        updater: async () => {
            throw new Error('DB_DOWN');
        },
        onWarn: () => {
            warnTriggered++;
        },
    });
    await sleep(120); // enough cycles for >3 failures
    stop();
    workerTest.activeJobs.delete(id);
    expect(warnTriggered).toBeGreaterThanOrEqual(1);
    const snap = workerTest.metrics.snapshot();
    const failCount = Object.entries(snap.counters)
        .filter(([k]) => k.startsWith('worker.heartbeat_failures_total'))
        .reduce((a, [, v]) => a + v, 0);
    expect(failCount).toBeGreaterThanOrEqual(4);
});
