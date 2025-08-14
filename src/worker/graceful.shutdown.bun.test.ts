import { test, expect } from 'bun:test';
import { __test as workerTest } from './index';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('waitForActiveJobsToFinish resolves immediately when no inflight', async () => {
    workerTest._internal.setInflight(0);
    const res = await workerTest._internal.waitForActiveJobsToFinish(50);
    expect(res.timedOut).toBeFalse();
    expect(res.aborted.length).toBe(0);
});

test('waitForActiveJobsToFinish times out and emits aborted events', async () => {
    // Simulate an in-flight job that won't finish
    workerTest._internal.setInflight(1);
    // Also register an active job id so aborted list isn't empty
    const jid = crypto.randomUUID();
    workerTest.activeJobs.add(jid);
    const res = await workerTest._internal.waitForActiveJobsToFinish(100);
    expect(res.timedOut).toBeTrue();
    expect(res.aborted).toContain(jid);
    // cleanup
    workerTest.activeJobs.delete(jid);
    workerTest._internal.setInflight(0);
});
