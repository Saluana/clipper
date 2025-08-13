import { test, expect, beforeEach } from 'bun:test';
import './index'; // ensure globals from worker are initialized

const { measureDirSizeBytes, cleanupScratch } =
    (globalThis as any).__scratchTest || {};

function tmpdir() {
    const id = crypto.randomUUID();
    return `/tmp/clipper-test-${id}`;
}

async function mkdirp(dir: string) {
    await Bun.spawn(['mkdir', '-p', dir]).exited;
}
async function touch(file: string, bytes = 1024) {
    const data = new Uint8Array(bytes);
    await Bun.write(file, data);
}
async function exists(path: string) {
    try {
        const p = Bun.file(path);
        return await p.exists();
    } catch {
        return false;
    }
}

beforeEach(() => {
    // reset env
    delete (process.env as any).KEEP_SCRATCH_ON_SUCCESS;
});

test('cleanupScratch deletes on success by default', async () => {
    const dir = tmpdir();
    await mkdirp(dir);
    await touch(`${dir}/a.bin`, 2048);
    const file = `${dir}/a.bin`;
    expect(await exists(file)).toBeTrue();
    const res = await cleanupScratch(dir, true);
    expect(res.deleted).toBeTrue();
    expect(await exists(file)).toBeFalse();
});

test('cleanupScratch keeps on success when KEEP_SCRATCH_ON_SUCCESS=1', async () => {
    const dir = tmpdir();
    await mkdirp(dir);
    await touch(`${dir}/a.bin`, 4096);
    const file = `${dir}/a.bin`;
    (process.env as any).KEEP_SCRATCH_ON_SUCCESS = '1';
    const res = await cleanupScratch(dir, true);
    expect(res.deleted).toBeFalse();
    expect(res.sizeBytes).toBeGreaterThan(0);
    expect(await exists(file)).toBeTrue();
    // cleanup
    await Bun.spawn(['rm', '-rf', dir]).exited;
});

test('cleanupScratch preserves on failure and logs size', async () => {
    const dir = tmpdir();
    await mkdirp(dir);
    await touch(`${dir}/a.bin`, 8192);
    const file = `${dir}/a.bin`;
    const res = await cleanupScratch(dir, false);
    expect(res.deleted).toBeFalse();
    expect(res.sizeBytes).toBeGreaterThan(0);
    expect(await exists(file)).toBeTrue();
    // cleanup
    await Bun.spawn(['rm', '-rf', dir]).exited;
});
