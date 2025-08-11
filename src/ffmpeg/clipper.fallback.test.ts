import { describe, it, expect, vi } from 'vitest';
import { BunClipper } from './clipper';

// We simulate fallback by providing a fake input that causes copy attempt to fail.
// Easiest: monkeypatch Bun.spawn to fail first invocation (contains '-c','copy') and succeed second.

function makeSpawnMock() {
    let attempt = 0;
    return vi.fn((args: string[], opts: any) => {
        const isCopy = args.includes('-c') && args.includes('copy');
        attempt++;
        const shouldFail = isCopy; // fail copy attempt
        const stdout = new ReadableStream<Uint8Array>({
            start(controller) {
                // emit minimal progress lines for parser
                const enc = new TextEncoder();
                controller.enqueue(enc.encode('out_time_ms=1000000\n'));
                controller.close();
            },
        });
        const stderr = new ReadableStream<Uint8Array>({
            start(c) {
                c.close();
            },
        });
        return {
            stdout,
            stderr,
            exited: Promise.resolve(shouldFail ? 1 : 0),
            kill() {},
        } as any;
    });
}

describe('BunClipper fallback logic', () => {
    it('falls back to re-encode when copy fails', async () => {
        // Polyfill Bun.file
        (globalThis as any).Bun = (globalThis as any).Bun || {};
        (globalThis as any).Bun.file = (p: string) => ({
            async arrayBuffer() {
                return new ArrayBuffer(0);
            },
            async exists() {
                return true;
            },
            size: 0,
        });
        const spawnMock = makeSpawnMock();
        (globalThis as any).Bun.spawn = spawnMock;

        const clipper = new BunClipper({ scratchDir: '/tmp' });
        const res = await clipper.clip({
            input: '/tmp/in.mp4',
            startSec: 0,
            endSec: 1,
            jobId: 'job1',
        });
        // Consume progress
        const seen: number[] = [];
        for await (const p of res.progress$) seen.push(p);
        expect(seen.at(-1)).toBe(100);
        // Ensure spawn called twice: copy then reencode
        expect(spawnMock.mock.calls.length).toBe(2);
        const firstArgs = spawnMock.mock.calls[0]![0] as string[];
        const secondArgs = spawnMock.mock.calls[1]![0] as string[];
        expect(firstArgs).toContain('copy');
        expect(secondArgs).not.toContain('copy');
    });
});
