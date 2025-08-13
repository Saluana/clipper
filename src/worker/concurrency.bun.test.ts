import { test, expect } from 'bun:test';
import { __test as workerTest } from './index';

// Simple semaphore behavior test

test('semaphore enforces max concurrency and updates gauge', async () => {
    const Sem = (workerTest as any).Semaphore as any;
    const sem = new Sem(2);
    const order: string[] = [];
    async function task(name: string, ms: number) {
        await sem.acquire();
        order.push('start-' + name + ':' + sem.inflight);
        await new Promise((r) => setTimeout(r, ms));
        sem.release();
        order.push('end-' + name + ':' + sem.inflight);
    }
    await Promise.all([
        task('a', 50),
        task('b', 50),
        task('c', 10),
        task('d', 10),
    ]);
    // At most 2 inflight at any start entries
    const starts = order.filter((o) => o.startsWith('start'));
    for (const s of starts) {
        const inflight = Number(s.split(':')[1]);
        expect(inflight).toBeLessThanOrEqual(2);
    }
    const snap = workerTest.metrics.snapshot();
    const gaugeEntries = Object.entries(snap.gauges || {}).filter(
        ([k]) => k === 'worker.concurrent_jobs'
    );
    expect(gaugeEntries.length).toBe(1);
});
