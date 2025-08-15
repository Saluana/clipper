import { describe, it, expect, beforeEach } from 'vitest';
import { probeSource } from './probe';

function streamFromString(s: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(s));
            controller.close();
        },
    });
}

// Ensure Bun exists in Vitest env
if (!(globalThis as any).Bun) (globalThis as any).Bun = {} as any;

describe('probeSource', () => {
    beforeEach(() => {
        // reset spawn mock per test
        (globalThis as any).Bun.spawn = undefined as any;
    });

    it('parses format and streams into a SourceProbe', async () => {
        const json = {
            format: {
                format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
                duration: '12.345',
            },
            streams: [
                {
                    codec_type: 'video',
                    codec_name: 'h264',
                    width: 1920,
                    height: 1080,
                },
                {
                    codec_type: 'audio',
                    codec_name: 'aac',
                    channels: 2,
                    sample_rate: '48000',
                },
            ],
        };
        (globalThis as any).Bun.spawn = () => ({
            stdout: streamFromString(JSON.stringify(json)),
            stderr: streamFromString(''),
            exited: Promise.resolve(0),
            kill: () => {},
        });
        const res = await probeSource('/tmp/in.mp4');
        expect(res).toBeTruthy();
        expect(res!.container).toContain('mp4');
        expect(res!.durationSec).toBeCloseTo(12.345, 3);
        expect(res!.video?.codec).toBe('h264');
        expect(res!.video?.width).toBe(1920);
        expect(res!.audio?.codec).toBe('aac');
        expect(res!.audio?.channels).toBe(2);
    });

    it('returns null on ffprobe failure/invalid JSON', async () => {
        (globalThis as any).Bun.spawn = () => ({
            stdout: streamFromString('{not-json'),
            stderr: streamFromString('error'),
            exited: Promise.resolve(0),
            kill: () => {},
        });
        const res = await probeSource('/tmp/in.mp4');
        expect(res).toBeNull();
    });
});
