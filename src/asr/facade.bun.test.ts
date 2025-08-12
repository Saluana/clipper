import { describe, test, expect, beforeEach } from 'bun:test';
import { AsrFacade } from './facade';

class FakeAsrJobsRepo {
    items = new Map<string, any>();
    reusable: any | null = null;
    async create(row: any) {
        const now = new Date().toISOString();
        const rec = { ...row, createdAt: now, updatedAt: now };
        this.items.set(row.id, rec);
        return rec;
    }
    async getReusable(hash: string, model: string) {
        return this.reusable;
    }
}

class FakeQueue {
    published: any[] = [];
    async publish(msg: any) {
        this.published.push(msg);
    }
}

describe('AsrFacade', () => {
    let tmp: string;
    beforeEach(async () => {
        tmp = `./tmp-test-audio-${Date.now()}.wav`;
        await Bun.write(tmp, new Uint8Array([1, 2, 3]));
    });

    test('returns reused job when available', async () => {
        const asrJobs = new FakeAsrJobsRepo();
        asrJobs.reusable = {
            id: 'reused-1',
            artifacts: [{ kind: 'srt', storageKey: 'k' }],
        };
        const facade = new AsrFacade({ asrJobs } as any);
        const res = await facade.request({ localPath: tmp });
        expect(res.status).toBe('reused');
        expect(res.asrJobId).toBe('reused-1');
        expect(res.artifacts?.length).toBe(1);
    });

    test('creates new job and enqueues when no reuse', async () => {
        const asrJobs = new FakeAsrJobsRepo();
        const queue = new FakeQueue();
        const facade = new AsrFacade({ asrJobs, queue } as any);
        const res = await facade.request({
            localPath: tmp,
            languageHint: 'auto',
        });
        expect(res.status).toBe('queued');
        expect(res.asrJobId).toBeTruthy();
        expect(queue.published[0]?.jobId).toBe(res.asrJobId);
        const created = asrJobs.items.get(res.asrJobId);
        expect(created?.mediaHash?.length).toBe(64); // sha256 hex
        expect(created?.languageHint).toBe('auto');
    });
});
