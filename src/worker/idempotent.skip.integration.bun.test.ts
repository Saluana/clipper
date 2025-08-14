import { test, expect } from 'bun:test';
import './index';
import { createDb } from '@clipper/data';
import { DrizzleJobsRepo, DrizzleJobEventsRepo } from '@clipper/data';

const db = createDb();
const jobs = new DrizzleJobsRepo(db);
const events = new DrizzleJobEventsRepo(db);

// Provide a fake storage that always returns ok for HEAD
class FakeStorage {
    async sign(key: string) {
        return `https://example.com/${key}`;
    }
    async upload(_: string, __: string, ___: string) {
        /* no-op */
    }
}

// Patch global override for worker storage
(globalThis as any).__storageOverride = new FakeStorage();

async function listTypes(jobId: string) {
    const rows = await events.list(jobId, 100, 0);
    return rows
        .sort((a: any, b: any) => a.ts.localeCompare(b.ts))
        .map((e: any) => e.type);
}

test('idempotent skip emits uploaded then done and sets done status', async () => {
    const originalFetch = globalThis.fetch;
    // Stub HEAD to always succeed
    // @ts-ignore
    globalThis.fetch = async (_input: any, init?: any) => ({ ok: true } as any);
    const id = crypto.randomUUID();
    await jobs.create({
        id,
        status: 'queued',
        progress: 0,
        sourceType: 'upload',
        sourceKey: 'key',
        sourceUrl: null as any,
        startSec: 0,
        endSec: 1,
        withSubtitles: false,
        burnSubtitles: false,
        subtitleLang: null as any,
        resultVideoKey: null as any,
        resultSrtKey: null as any,
        errorCode: null as any,
        errorMessage: null as any,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    } as any);
    const finalKey = `results/${id}/clip.mp4`;
    // call short-circuit helper directly
    const helper = (globalThis as any).__idempotentTest
        ?.maybeShortCircuitIdempotent;
    expect(helper).toBeTypeOf('function');
    const didSkip = await helper(id, finalKey, 'cid');
    expect(didSkip).toBeTrue();
    // verify
    const types = await listTypes(id);
    expect(types.includes('uploaded')).toBeTrue();
    expect(types[types.length - 1]).toBe('done');
    const job = await jobs.get(id);
    expect(job?.status).toBe('done');
    // restore
    globalThis.fetch = originalFetch;
});
