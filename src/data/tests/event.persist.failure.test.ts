import 'dotenv/config';
import { describe, test, expect } from 'vitest';
import { createDb } from '../db/connection';
import { DrizzleJobEventsRepo } from '../db/repos';
import { InMemoryMetrics } from '@clipper/common/metrics';

// Tests Req 8.2: DB failure path increments events.persist_failures_total
// Strategy: attempt to insert an event referencing a non-existent job id to trigger FK violation.

describe('JobEvents persistence failure metrics', () => {
    test('increments events.persist_failures_total on foreign key violation', async () => {
        const db = createDb();
        const metrics = new InMemoryMetrics();
        const repo = new DrizzleJobEventsRepo(db, metrics);
        const badJobId = crypto.randomUUID(); // not inserted into jobs table
        const before =
            metrics.snapshot().counters['events.persist_failures_total'] || 0;
        await expect(
            repo.add({
                jobId: badJobId,
                ts: new Date().toISOString(),
                type: 'test:event',
                data: { foo: 'bar' },
            })
        ).rejects.toThrow();
        const after =
            metrics.snapshot().counters['events.persist_failures_total'] || 0;
        expect(after).toBe(before + 1);
    });
});
