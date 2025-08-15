import { describe, it, expect, beforeEach } from 'vitest';
import { shouldAttemptCopy } from './copy-decision';

function streamFromString(s: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(s));
            controller.close();
        },
    });
}

if (!(globalThis as any).Bun) (globalThis as any).Bun = {} as any;

describe('shouldAttemptCopy', () => {
    beforeEach(() => {
        (globalThis as any).Bun.spawn = undefined as any;
        if (Bun.env as any) {
            delete (Bun.env as any).REQUIRE_KEYFRAME_FOR_COPY;
            delete (Bun.env as any).KEYFRAME_PROXIMITY_SEC;
        }
    });

    it('returns true when feature flag is disabled', async () => {
        (Bun.env as any).REQUIRE_KEYFRAME_FOR_COPY = 'false';
        const ok = await shouldAttemptCopy({
            inputPath: '/tmp/in.mp4',
            startSec: 10,
        });
        expect(ok).toBe(true);
    });

    it('returns true when keyframe is within proximity', async () => {
        (Bun.env as any).REQUIRE_KEYFRAME_FOR_COPY = 'true';
        (Bun.env as any).KEYFRAME_PROXIMITY_SEC = '0.5';
        const frames = { frames: [{ pkt_pts_time: '10.25' }] };
        (globalThis as any).Bun.spawn = () => ({
            stdout: streamFromString(JSON.stringify(frames)),
            stderr: streamFromString(''),
            exited: Promise.resolve(0),
            kill: () => {},
        });
        const ok = await shouldAttemptCopy({
            inputPath: '/tmp/in.mp4',
            startSec: 10.1,
        });
        expect(ok).toBe(true);
    });

    it('returns false when keyframe is beyond proximity', async () => {
        (Bun.env as any).REQUIRE_KEYFRAME_FOR_COPY = 'true';
        (Bun.env as any).KEYFRAME_PROXIMITY_SEC = '0.5';
        const frames = { frames: [{ pkt_pts_time: '11.0' }] };
        (globalThis as any).Bun.spawn = () => ({
            stdout: streamFromString(JSON.stringify(frames)),
            stderr: streamFromString(''),
            exited: Promise.resolve(0),
            kill: () => {},
        });
        const ok = await shouldAttemptCopy({
            inputPath: '/tmp/in.mp4',
            startSec: 10.1,
        });
        expect(ok).toBe(false);
    });

    it('returns false conservatively on probe failure when required', async () => {
        (Bun.env as any).REQUIRE_KEYFRAME_FOR_COPY = 'true';
        (globalThis as any).Bun.spawn = () => ({
            stdout: streamFromString('{not-json'),
            stderr: streamFromString(''),
            exited: Promise.resolve(0),
            kill: () => {},
        });
        const ok = await shouldAttemptCopy({
            inputPath: '/tmp/in.mp4',
            startSec: 5,
        });
        expect(ok).toBe(false);
    });
});
