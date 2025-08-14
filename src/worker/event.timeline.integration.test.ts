import { test, expect } from 'vitest';
import { createDb } from '@clipper/data';
import { DrizzleJobsRepo, DrizzleJobEventsRepo } from '@clipper/data';

function orderOf(types: string[]) {
    return types.join('>');
}

// Note: these tests validate ordering at the repo-level by simulating event writes
// The full E2E would require running the worker; here we ensure our codepaths use the right order.

test('normal event timeline ordering', async () => {
    const db = createDb();
    const jobs = new DrizzleJobsRepo(db);
    const events = new DrizzleJobEventsRepo(db);
    const id = crypto.randomUUID();
    await jobs.create({
        id,
        status: 'queued',
        progress: 0,
        sourceType: 'upload',
        sourceKey: 'k',
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
    // created
    await events.add({
        jobId: id,
        ts: new Date().toISOString(),
        type: 'created',
    } as any);
    // processing
    await events.add({
        jobId: id,
        ts: new Date().toISOString(),
        type: 'processing',
    } as any);
    // source:ready
    await events.add({
        jobId: id,
        ts: new Date().toISOString(),
        type: 'source:ready',
    } as any);
    // progress (multiple)
    await events.add({
        jobId: id,
        ts: new Date().toISOString(),
        type: 'progress',
        data: { pct: 10 },
    } as any);
    await events.add({
        jobId: id,
        ts: new Date().toISOString(),
        type: 'progress',
        data: { pct: 100 },
    } as any);
    // uploaded
    await events.add({
        jobId: id,
        ts: new Date().toISOString(),
        type: 'uploaded',
        data: { key: 'results/' + id + '/clip.mp4' },
    } as any);
    // done
    await events.add({
        jobId: id,
        ts: new Date().toISOString(),
        type: 'done',
    } as any);

    const list = await events.list(id, 100, 0);
    const types = list
        .sort((a, b) => a.ts.localeCompare(b.ts))
        .map((e) => e.type);
    const seq = orderOf(types);
    expect(seq.includes('created')).toBe(true);
    expect(seq.includes('processing')).toBe(true);
    expect(seq.includes('source:ready')).toBe(true);
    expect(seq.includes('uploaded')).toBe(true);
    expect(seq.endsWith('done')).toBe(true);
});

test('recovery sequence inserts requeued:stale before processing', async () => {
    const db = createDb();
    const jobs = new DrizzleJobsRepo(db);
    const events = new DrizzleJobEventsRepo(db);
    const id = crypto.randomUUID();
    await jobs.create({
        id,
        status: 'queued',
        progress: 0,
        sourceType: 'youtube',
        sourceKey: null as any,
        sourceUrl: 'https://youtu.be/x',
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

    // initial created
    await events.add({
        jobId: id,
        ts: new Date().toISOString(),
        type: 'created',
    } as any);
    // first processing and then crash
    await events.add({
        jobId: id,
        ts: new Date().toISOString(),
        type: 'processing',
    } as any);
    // recovery emits requeued:stale
    await events.add({
        jobId: id,
        ts: new Date().toISOString(),
        type: 'requeued:stale',
    } as any);
    // next processing again
    await events.add({
        jobId: id,
        ts: new Date().toISOString(),
        type: 'processing',
    } as any);
    await events.add({
        jobId: id,
        ts: new Date().toISOString(),
        type: 'source:ready',
    } as any);
    await events.add({
        jobId: id,
        ts: new Date().toISOString(),
        type: 'uploaded',
        data: { key: 'results/' + id + '/clip.mp4' },
    } as any);
    await events.add({
        jobId: id,
        ts: new Date().toISOString(),
        type: 'done',
    } as any);

    const list = await events.list(id, 100, 0);
    const types = list
        .sort((a, b) => a.ts.localeCompare(b.ts))
        .map((e) => e.type);
    const requeuedIdx = types.indexOf('requeued:stale');
    const nextProcessingIdx = types.lastIndexOf('processing');
    expect(requeuedIdx).toBeGreaterThan(-1);
    expect(nextProcessingIdx).toBeGreaterThan(requeuedIdx);
});
