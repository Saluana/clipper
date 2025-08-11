import { describe, it, expect } from 'vitest';
import { BunClipper } from './clipper';

// Minimal Bun.file polyfill
if (!(globalThis as any).Bun) (globalThis as any).Bun = {};
(globalThis as any).Bun.file = (p: string) => ({
    async arrayBuffer() {
        return new ArrayBuffer(0);
    },
    async exists() {
        return true;
    },
    size: 0,
});
(globalThis as any).Bun.spawn = (..._args: any[]) => ({
    stdout: null,
    stderr: null,
    exited: Promise.resolve(0),
});

describe('BunClipper validation', () => {
    const clipper = new BunClipper({ scratchDir: '/tmp' });
    it('rejects when endSec <= startSec', async () => {
        await expect(
            clipper.clip({
                input: '/tmp/in.mp4',
                startSec: 5,
                endSec: 5,
                jobId: 'x',
            })
        ).rejects.toThrow(/endSec/);
        await expect(
            clipper.clip({
                input: '/tmp/in.mp4',
                startSec: 5,
                endSec: 4,
                jobId: 'x',
            })
        ).rejects.toThrow(/endSec/);
    });
    it('rejects negative times', async () => {
        await expect(
            clipper.clip({
                input: '/tmp/in.mp4',
                startSec: -1,
                endSec: 1,
                jobId: 'x',
            })
        ).rejects.toThrow(/start\/end/);
    });
});
