import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createSupabaseStorageRepo } from '../../storage';

class FakeBucket {
    uploaded: Array<{ key: string; blob: Blob }>[] = [] as any;
}

class FakeSupabaseClient {
    bucket = new FakeBucket();
    storage = {
        from: (_bucket: string) => ({
            upload: async (key: string, blob: Blob, _opts: any) => {
                (this.bucket.uploaded as any).push({ key, blob });
                return { error: null };
            },
            createSignedUrl: async (key: string, _ttl: number) => ({
                data: { signedUrl: `https://example.com/${key}?sig=1` },
                error: null,
            }),
            remove: async (_keys: string[]) => ({ error: null }),
        }),
    };
}

function makeTmpFile(contents: string) {
    const path = `${process.cwd()}/tmp-${Math.random()
        .toString(36)
        .slice(2)}.txt`;
    Bun.write(path, contents);
    return path;
}

describe('SupabaseStorageRepo (Bun runtime)', () => {
    it('uploads via Bun.file and signs URL', async () => {
        const fake = new (FakeSupabaseClient as any)();
        const repo = createSupabaseStorageRepo({
            url: 'x',
            serviceRoleKey: 'y',
            bucket: 'b',
            client: fake as any,
        });
        const tmp = makeTmpFile('hello');
        await repo.upload(tmp, 'results/a.txt', 'text/plain');
        const url = await repo.sign('results/a.txt', 60);
        expect(url).toContain('https://example.com/results/a.txt');
    });

    it('uploads using Node fs fallback when FORCE_NODE_FS=1', async () => {
        const old = process.env.FORCE_NODE_FS;
        process.env.FORCE_NODE_FS = '1';
        try {
            const fake = new (FakeSupabaseClient as any)();
            const repo = createSupabaseStorageRepo({
                url: 'x',
                serviceRoleKey: 'y',
                bucket: 'b',
                client: fake as any,
            });
            const tmp = makeTmpFile('node-path');
            await repo.upload(tmp, 'results/b.txt', 'text/plain');
            const url = await repo.sign('results/b.txt', 60);
            expect(url).toContain('https://example.com/results/b.txt');
        } finally {
            if (old == null) delete process.env.FORCE_NODE_FS;
            else process.env.FORCE_NODE_FS = old;
        }
    });
});
