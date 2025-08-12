import { test, expect } from 'bun:test';
import 'dotenv/config';

// Provide dummy DATABASE_URL for app initialization if missing (pool connects lazily)
if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/testdb';
}

test('http metrics: /healthz success and 404 error are recorded', async () => {
    const { app, metrics } = await import('../index');
    const before = metrics.snapshot();

    const ok = await app.handle(new Request('http://test/healthz'));
    expect(ok.status).toBe(200);
    await ok.text();

    const nf = await app.handle(new Request('http://test/does-not-exist'));
    expect(nf.status).toBe(404);
    await nf.text();

    const after = metrics.snapshot();
    const beforeReq = Object.entries(before.counters)
        .filter(([k]) => k.startsWith('http.requests_total'))
        .reduce((a, [, v]) => a + v, 0);
    const afterReq = Object.entries(after.counters)
        .filter(([k]) => k.startsWith('http.requests_total'))
        .reduce((a, [, v]) => a + v, 0);
    expect(afterReq - beforeReq).toBeGreaterThanOrEqual(2);

    const errors = Object.entries(after.counters)
        .filter(([k]) => k.startsWith('http.errors_total'))
        .reduce((a, [, v]) => a + v, 0);
    expect(errors).toBeGreaterThanOrEqual(1);

    const latencyKeys = Object.keys(after.histograms).filter((k) =>
        k.startsWith('http.request_latency_ms')
    );
    expect(latencyKeys.length).toBeGreaterThan(0);
});
