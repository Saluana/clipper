import { test, expect } from 'bun:test';
import './index';

const { cleanupOnFailure } = (globalThis as any).__cleanupTest || {};
if (!cleanupOnFailure) throw new Error('cleanupOnFailure not exposed');

function tmpdir() {
    const id = crypto.randomUUID();
    return `/tmp/clipper-test-${id}`;
}
async function mkdirp(dir: string) {
    await Bun.spawn(['mkdir', '-p', dir]).exited;
}
async function touch(file: string, bytes = 1024) {
    await Bun.write(file, new Uint8Array(bytes));
}
async function exists(path: string) {
    try {
        return await Bun.file(path).exists();
    } catch {
        return false;
    }
}

class MemoryStorage {
    set = new Set<string>();
    async upload(path: string, key: string) {
        this.set.add(key);
    }
    async remove(key: string) {
        this.set.delete(key);
    }
}

test('cleanupOnFailure removes scratch and partial storage by default', async () => {
    delete (process.env as any).KEEP_FAILED;
    const scratch = tmpdir();
    await mkdirp(scratch);
    const f = `${scratch}/out.tmp.mp4`;
    await touch(f, 2048);
    const storage = new MemoryStorage();
    storage.set.add('results/abc/clip.mp4');
    await cleanupOnFailure({
        scratchDir: scratch,
        storage,
        storageKey: 'results/abc/clip.mp4',
    });
    expect(await exists(f)).toBeFalse();
    expect(storage.set.has('results/abc/clip.mp4')).toBeFalse();
});

test('cleanupOnFailure honors KEEP_FAILED=1 (preserves scratch and storage)', async () => {
    (process.env as any).KEEP_FAILED = '1';
    const scratch = tmpdir();
    await mkdirp(scratch);
    const f = `${scratch}/out.tmp.mp4`;
    await touch(f, 1024);
    const storage = new MemoryStorage();
    storage.set.add('results/xyz/clip.mp4');
    await cleanupOnFailure({
        scratchDir: scratch,
        storage,
        storageKey: 'results/xyz/clip.mp4',
    });
    // scratch preserved
    expect(await exists(f)).toBeTrue();
    // storage preserved
    expect(storage.set.has('results/xyz/clip.mp4')).toBeTrue();
    // cleanup
    await Bun.spawn(['rm', '-rf', scratch]).exited;
});
