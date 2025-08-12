import 'dotenv/config';
import { test, expect } from 'vitest';

// Provide dummy DATABASE_URL so API module can initialize without real DB connectivity for metrics test.
if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/testdb';
}

// Skip if DB not configured? Healthz uses queue health which is stubbed if no DB.
const HAS_DB = !!process.env.DATABASE_URL;

// We still run; queue health is stubbed ok.

test('GET /healthz and 404 produce http metrics', async () => {
    const { app, metrics } = await import('../index');

    // Clear metrics snapshot by creating new registry not exposed; instead we rely on counts increasing
    const before = metrics.snapshot();
    const resOk = await app.handle(new Request('http://local/healthz'));
    expect(resOk.status).toBe(200);
    await resOk.text();

    const res404 = await app.handle(new Request('http://local/does-not-exist'));
    expect(res404.status).toBe(404);
    await res404.text();

    const snap = metrics.snapshot();
    // Find counters matching http.requests_total
    const httpCounters = Object.entries(snap.counters).filter(([k]) =>
        k.startsWith('http.requests_total')
    );
    // Should have at least two increments total vs before
    const beforeTotal = Object.entries(before.counters)
        .filter(([k]) => k.startsWith('http.requests_total'))
        .reduce((a, [, v]) => a + v, 0);
    const afterTotal = httpCounters.reduce((a, [, v]) => a + v, 0);
    expect(afterTotal - beforeTotal).toBeGreaterThanOrEqual(2);

    // Ensure latency histogram present
    const latencyKeys = Object.keys(snap.histograms).filter((k) =>
        k.startsWith('http.request_latency_ms')
    );
    expect(latencyKeys.length).toBeGreaterThan(0);

    // Ensure errors counter incremented for 404
    const errorCounters = Object.entries(snap.counters).filter(([k]) =>
        k.startsWith('http.errors_total')
    );
    const errorTotal = errorCounters.reduce((a, [, v]) => a + v, 0);
    expect(errorTotal).toBeGreaterThan(0);
});
