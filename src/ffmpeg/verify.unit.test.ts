import { describe, it, expect, beforeEach } from 'vitest';
import { outputVerifier, __internals__ } from './verify.ts';

function streamFromString(s: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(s));
            controller.close();
        },
    });
}

if (!(globalThis as any).Bun) (globalThis as any).Bun = {} as any;

describe('outputVerifier.verify', () => {
    beforeEach(() => {
        (globalThis as any).Bun.spawn = undefined as any;
    });

    it('passes when duration within tolerance, has streams, and faststart', async () => {
        const probe = {
            format: { duration: '9.6', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
            streams: [
                { codec_type: 'video', codec_name: 'h264' },
                { codec_type: 'audio', codec_name: 'aac' },
            ],
        };
        (globalThis as any).Bun.spawn = () => ({
            stdout: streamFromString(JSON.stringify(probe)),
            stderr: streamFromString(''),
            exited: Promise.resolve(0),
            kill: () => {},
        });

        // stub faststart checker to true by overriding readHeadBytes
        const fileBytes = new TextEncoder().encode('xxxxmoov....mdat');
        (globalThis as any).Bun.file = () => ({
            slice: () => ({ arrayBuffer: async () => fileBytes.buffer }),
            stream: () =>
                new ReadableStream<Uint8Array>({
                    start(c) {
                        c.enqueue(fileBytes);
                        c.close();
                    },
                }),
        });

        const res = await outputVerifier.verify('/tmp/out.mp4', {
            expectDurationSec: 10,
            toleranceSec: 1,
            requireFastStart: true,
            requireVideoOrAudio: 'either',
            allowedVideoCodecs: ['h264'],
            allowedAudioCodecs: ['aac'],
        });
        expect(res.ok).toBe(true);
    });

    it('fails on duration mismatch', async () => {
        const probe = {
            format: { duration: '5.1', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
            streams: [{ codec_type: 'video', codec_name: 'h264' }],
        };
        (globalThis as any).Bun.spawn = () => ({
            stdout: streamFromString(JSON.stringify(probe)),
            stderr: streamFromString(''),
            exited: Promise.resolve(0),
            kill: () => {},
        });

        const res = await outputVerifier.verify('/tmp/out.mp4', {
            expectDurationSec: 10,
            toleranceSec: 0.5,
            requireFastStart: false,
            requireVideoOrAudio: 'either',
        });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toContain('duration');
    });

    it('fails when stream types missing', async () => {
        const probe = { format: { duration: '9.9' }, streams: [] };
        (globalThis as any).Bun.spawn = () => ({
            stdout: streamFromString(JSON.stringify(probe)),
            stderr: streamFromString(''),
            exited: Promise.resolve(0),
            kill: () => {},
        });
        const res = await outputVerifier.verify('/tmp/out.mkv', {
            expectDurationSec: 10,
            toleranceSec: 1,
            requireFastStart: false,
            requireVideoOrAudio: 'either',
        });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe('required_streams_missing');
    });

    it('enforces codec allowlists', async () => {
        const probe = {
            format: { duration: '10.0' },
            streams: [
                { codec_type: 'video', codec_name: 'vp9' },
                { codec_type: 'audio', codec_name: 'aac' },
            ],
        };
        (globalThis as any).Bun.spawn = () => ({
            stdout: streamFromString(JSON.stringify(probe)),
            stderr: streamFromString(''),
            exited: Promise.resolve(0),
            kill: () => {},
        });
        const res = await outputVerifier.verify('/tmp/out.webm', {
            expectDurationSec: 10,
            toleranceSec: 0.5,
            requireFastStart: false,
            requireVideoOrAudio: 'either',
            allowedVideoCodecs: ['h264'],
        });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe('video_codec_not_allowed');
    });
});
