import { describe, it, expect, vi } from 'vitest';
// Mock output verifier to avoid depending on ffprobe/faststart in this unit test
vi.mock('./verify.ts', () => ({
    outputVerifier: { verify: vi.fn().mockResolvedValue({ ok: true }) },
}));
import { BunClipper } from './clipper';

// We simulate fallback by providing a fake input that causes copy attempt to fail.
// Easiest: monkeypatch Bun.spawn to fail first invocation (contains '-c','copy') and succeed second.

function makeSpawnMock() {
    let attempt = 0;
    return vi.fn((args: string[], opts: any) => {
        const isCopy = args.includes('-c') && args.includes('copy');
        const isFfprobe = args[0] === 'ffprobe';
        attempt++;
        const shouldFail = isCopy; // fail copy attempt
        const stdout = new ReadableStream<Uint8Array>({
            start(controller) {
                const enc = new TextEncoder();
                if (isFfprobe) {
                    // Minimal ffprobe JSON to let probeSource succeed
                    controller.enqueue(
                        enc.encode(
                            JSON.stringify({
                                format: { duration: '2', format_name: 'mp4' },
                                streams: [
                                    { codec_type: 'video', codec_name: 'h264' },
                                    { codec_type: 'audio', codec_name: 'aac' },
                                ],
                            })
                        )
                    );
                } else {
                    // emit minimal progress lines for parser
                    controller.enqueue(enc.encode('out_time_ms=1000000\n'));
                }
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
        // Ensure ffmpeg was invoked twice (copy then reencode); ignore ffprobe call
        const ffmpegCalls = spawnMock.mock.calls.filter(
            (c) => (c[0] as string[])[0] === 'ffmpeg'
        );
        expect(ffmpegCalls.length).toBe(2);
        const firstArgs = ffmpegCalls[0]![0] as string[];
        const secondArgs = ffmpegCalls[1]![0] as string[];
        expect(firstArgs).toContain('copy');
        expect(secondArgs).not.toContain('copy');
    });
});
