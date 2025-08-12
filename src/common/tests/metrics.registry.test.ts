import { describe, it, expect } from 'vitest';
import { MetricsRegistry, normalizeRoute } from '../metrics';

describe('MetricsRegistry', () => {
    it('reuses same counter instance', () => {
        const r = new MetricsRegistry();
        const c1 = r.counter('jobs.created');
        c1.inc(1);
        const c2 = r.counter('jobs.created');
        c2.inc(2);
        const snap = r.snapshot();
        expect(snap.counters['jobs.created']).toBe(3);
    });

    it('enforces label cardinality limit', () => {
        const r = new MetricsRegistry({ maxLabelSetsPerMetric: 2 });
        for (let i = 0; i < 5; i++) {
            r.inc('requests.total', 1, { route: `/r${i}` });
        }
        const snap = r.snapshot();
        // Only 2 unique label sets should be present
        const keys = Object.keys(snap.counters).filter((k) =>
            k.startsWith('requests.total')
        );
        expect(keys.length).toBe(2);
    });

    it('histogram fixed buckets accumulate', () => {
        const r = new MetricsRegistry({ defaultHistogramBuckets: [10, 20] });
        [5, 15, 25].forEach((v) => r.observe('latency_ms', v));
        const snap = r.snapshot();
        const h = snap.histograms['latency_ms'];
        expect(h).toBeTruthy();
        if (!h) throw new Error('histogram missing');
        expect(h.count).toBe(3);
        // Buckets cumulative: <=10 should count 1, <=20 should count 2, +Inf 3
        const b10 = h.buckets.find((b) => b.le === 10)!;
        const b20 = h.buckets.find((b) => b.le === 20)!;
        const bInf = h.buckets.find((b) => !isFinite(b.le))!;
        expect(b10.count).toBe(1);
        expect(b20.count).toBe(2);
        expect(bInf.count).toBe(3);
    });
});

describe('normalizeRoute', () => {
    it('replaces uuid and numeric segments with :id', () => {
        const raw = '/api/jobs/123e4567-e89b-12d3-a456-426614174000/results/42';
        expect(normalizeRoute(raw)).toBe('/api/jobs/:id/results/:id');
    });
    it('preserves static segments', () => {
        expect(normalizeRoute('/healthz')).toBe('/healthz');
    });
});
