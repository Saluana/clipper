import { test, expect } from 'bun:test';
import './index';
import { __test as workerTest } from './index';

// Utility
const snapGauge = (name: string) => {
    const s = workerTest.metrics.snapshot();
    const entries = Object.entries(s.counters).filter(([k]) =>
        k.startsWith(name)
    );
    return entries.reduce((a, [, v]) => a + v, 0);
};

test('heartbeat counters increment', async () => {
    // trigger heartbeat loop and updater via test hook
    const stop = workerTest.startHeartbeatLoop({
        intervalMs: 10,
        updater: async () => {},
    });
    workerTest.activeJobs.add('j1');
    await new Promise((r) => setTimeout(r, 35));
    workerTest.activeJobs.delete('j1');
    stop();
    const total = snapGauge('worker.heartbeats_total');
    expect(total).toBeGreaterThanOrEqual(2);
});

test('retry_attempts_total{code}', async () => {
    workerTest.metrics.inc('worker.retry_attempts_total', 1, {
        code: 'retryable',
    });
    workerTest.metrics.inc('worker.retry_attempts_total', 1, { code: 'fatal' });
    const s = workerTest.metrics.snapshot();
    const keys = Object.keys(s.counters).filter((k) =>
        k.startsWith('worker.retry_attempts_total')
    );
    expect(keys.some((k) => k.includes('{code=fatal}'))).toBeTrue();
    expect(keys.some((k) => k.includes('{code=retryable}'))).toBeTrue();
});

test('duplicate_skips_total and acquire_conflicts_total counters exist', async () => {
    workerTest.metrics.inc('worker.duplicate_skips_total');
    workerTest.metrics.inc('worker.acquire_conflicts_total');
    const s = workerTest.metrics.snapshot();
    expect(
        Object.keys(s.counters).some((k) =>
            k.startsWith('worker.duplicate_skips_total')
        )
    ).toBeTrue();
    expect(
        Object.keys(s.counters).some((k) =>
            k.startsWith('worker.acquire_conflicts_total')
        )
    ).toBeTrue();
});
