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
});
