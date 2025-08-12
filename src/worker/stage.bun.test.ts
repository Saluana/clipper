import { test, expect } from 'bun:test';
import { InMemoryMetrics } from '@clipper/common/metrics';
import { withStage } from './stage';

function snapshotCounter(reg: InMemoryMetrics, namePrefix: string) {
    const snap = reg.snapshot();
    return Object.entries(snap.counters)
        .filter(([k]) => k.startsWith(namePrefix))
        .reduce((a, [k, v]) => {
            a[k] = v;
            return a;
        }, {} as Record<string, number>);
}

function findHistogramSample(
    reg: InMemoryMetrics,
    base: string,
    labels: Record<string, string>
) {
    const snap = reg.snapshot();
    // histograms snapshot uses flattened key with labels, similar to counters
    const labelStr = Object.entries(labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
    return snap.histograms[`${base}{${labelStr}}`];
}

test('withStage success records latency', async () => {
    const m = new InMemoryMetrics();
    await withStage(m, 'resolve', async () => {
        await new Promise((r) => setTimeout(r, 5));
    });
    const h = findHistogramSample(m, 'worker.stage_latency_ms', {
        stage: 'resolve',
    });
    expect(h?.count).toBe(1);
    expect(h?.sum ?? 0).toBeGreaterThan(0);
});

test('withStage failure records latency + failure counter with classification', async () => {
    const m = new InMemoryMetrics();
    const err = new Error('Timeout while downloading');
    await expect(
        withStage(m, 'clip', async () => {
            throw err;
        })
    ).rejects.toThrow('Timeout');
    const snap = m.snapshot();
    const h = findHistogramSample(m, 'worker.stage_latency_ms', {
        stage: 'clip',
    });
    expect(h?.count).toBe(1);
    const failureEntry = Object.entries(snap.counters).find(([k]) =>
        k.startsWith('worker.stage_failures_total{')
    );
    expect(failureEntry).toBeTruthy();
    const [k, v] = failureEntry!;
    expect(v).toBe(1);
    expect(k).toContain('stage=clip');
    expect(k).toContain('code=timeout');
});
