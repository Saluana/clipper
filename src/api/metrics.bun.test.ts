import { test, expect } from 'vitest';
const HAS_DB = !!process.env.DATABASE_URL;
test.skipIf(!HAS_DB)(
    'GET /metrics returns counters & histograms structure',
    async () => {
        const { app } = await import('./index');
        const res = await app.handle(new Request('http://test/metrics'));
        expect(res.status).toBe(200);
        const json: any = await res.json();
        expect(json).toBeTruthy();
        expect(json.counters).toBeTypeOf('object');
        expect(json.histograms).toBeTypeOf('object');
    }
);
