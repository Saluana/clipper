import { describe, test, expect } from 'vitest';
import { InMemoryJobsRepo, InMemoryJobEventsRepo, type JobRow } from '../repo';

describe('InMemory Repositories (unit)', () => {
    test('jobs: create/get/update/list/transition', async () => {
        const jobs = new InMemoryJobsRepo();
        const id = crypto.randomUUID();
        const base: Omit<JobRow, 'createdAt' | 'updatedAt'> = {
            id,
            status: 'queued',
            progress: 0,
            sourceType: 'upload',
            startSec: 0,
            endSec: 10,
            withSubtitles: false,
            burnSubtitles: false,
        };

        const created = await jobs.create(base);
        expect(created.id).toBe(id);

        const got = await jobs.get(id);
        expect(got?.id).toBe(id);

        const listed = await jobs.listByStatus('queued', 10, 0);
        expect(listed.some((j) => j.id === id)).toBe(true);

        const updated = await jobs.update(id, { progress: 25 });
        expect(updated.progress).toBe(25);

        const transitioned = await jobs.transition(id, 'processing', {
            type: 'status:processing',
            data: { step: 'claim' },
        });
        expect(transitioned.status).toBe('processing');
    });

    test('jobs: error on update/transition missing id', async () => {
        const jobs = new InMemoryJobsRepo();
        await expect(jobs.update('missing', { progress: 1 })).rejects.toThrow(
            'NOT_FOUND'
        );
        await expect(
            jobs.transition('missing', 'done', { type: 'status:done' })
        ).rejects.toThrow('NOT_FOUND');
    });

    test('job events: add/list ordering', async () => {
        const events = new InMemoryJobEventsRepo();
        const jobId = crypto.randomUUID();
        await events.add({ jobId, ts: '2024-01-01T00:00:00.000Z', type: 'a' });
        await events.add({ jobId, ts: '2024-01-01T00:00:01.000Z', type: 'b' });
        const list = await events.list(jobId, 10, 0);
        expect(list.length).toBe(2);
        expect(list[0]!.type).toBe('a');
        expect(list[1]!.type).toBe('b');
    });
});
