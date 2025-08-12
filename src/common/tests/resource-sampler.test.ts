import { test, expect } from 'vitest';
import { InMemoryMetrics } from '../metrics';
import { ResourceSampler } from '../resource-sampler';

function snapshotGauge(reg: InMemoryMetrics, name: string) {
    return Object.entries(reg.snapshot().gauges || {}).filter(([k]) =>
        k.startsWith(name)
    )[0]?.[1];
}

function histogramValues(reg: InMemoryMetrics, name: string) {
    return Object.entries(reg.snapshot().histograms || {}).filter(([k]) =>
        k.startsWith(name)
    )[0]?.[1];
}

test('resource sampler records rss and lag + scratch pct sentinel', async () => {
    const m = new InMemoryMetrics();
    let now = 0;
    const sampler = new ResourceSampler({
        metrics: m,
        intervalMs: 100,
        scratchDir: '/does/not/exist',
        getScratchUsage: async () => ({ usedBytes: 500, capacityBytes: 1000 }),
        now: () => now,
    });
    sampler.start();
    // First tick establishes baseline
    await sampler.tick();
    now += 120; // simulate 20ms lag over 100ms interval
    await sampler.tick();
    const rss = snapshotGauge(m, 'proc.memory_rss_mb');
    expect(typeof rss).toBe('number');
    const pct = snapshotGauge(m, 'scratch.disk_used_pct');
    expect(pct).toBe(50); // 500/1000 * 100
    const lagHist: any = histogramValues(m, 'event_loop.lag_ms');
    expect(lagHist.count).toBeGreaterThan(0);
    sampler.stop();
});
