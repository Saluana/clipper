import { describe, it, expect } from 'vitest';
import { parseFfmpegProgress } from './progress';

function makeProgressStream(timesMs: number[]): ReadableStream<Uint8Array> {
    const lines = timesMs.map((t) => `out_time_ms=${t}`); // Each line represents a progress timestamp
    const joined = lines.join('\n') + '\n';
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(joined));
            controller.close();
        },
    });
}

describe('parseFfmpegProgress', () => {
    it('yields monotonically increasing percentages and final 100', async () => {
        const totalSec = 10; // 10s target
        const times = [0, 1_000_000, 4_000_000, 7_500_000, 10_000_000];
        const stream = makeProgressStream(times);
        const seen: number[] = [];
        for await (const pct of parseFfmpegProgress(stream, totalSec)) {
            seen.push(pct);
        }
        expect(seen.at(-1)).toBe(100);
        for (let i = 1; i < seen.length; i++) {
            expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
        }
    });

    it('handles zero/invalid duration by emitting 100 immediately', async () => {
        const s = makeProgressStream([1_000_000, 2_000_000]);
        const seen: number[] = [];
        for await (const pct of parseFfmpegProgress(s, 0)) {
            seen.push(pct);
        }
        expect(seen).toEqual([100]);
    });

    it('caps at 99% until exit even if ffmpeg reports >=100%', async () => {
        const totalSec = 10;
        const times = [9_900_000, 10_000_000, 11_000_000];
        const stream = makeProgressStream(times);
        const seen: number[] = [];
        for await (const pct of parseFfmpegProgress(stream, totalSec)) {
            seen.push(pct);
        }
        // The last before 100 should be 99
        expect(seen[seen.length - 2]).toBe(99);
        expect(seen.at(-1)).toBe(100);
    });

    it('emits 100 immediately for near-zero durations (< MIN_DURATION_SEC)', async () => {
        // Default MIN_DURATION_SEC in env.ts readers is 0.5; use 0.5 behavior
        const s = makeProgressStream([100_000]);
        const seen: number[] = [];
        for await (const pct of parseFfmpegProgress(s, 0.25)) {
            seen.push(pct);
        }
        expect(seen).toEqual([100]);
    });
});
