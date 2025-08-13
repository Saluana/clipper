import { test, expect } from 'bun:test';
import { __progressTest } from './index';

async function* makeProgress(seq: number[], delayMs = 0) {
    for (const v of seq) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        yield v;
    }
}

test('progress throttling emits on +1 delta or time debounce and always final 100', async () => {
    const emitted: number[] = [];
    const iter = makeProgress([0, 0, 0, 1, 1, 2, 2, 2, 50, 50, 51, 99, 100]);
    await __progressTest.throttleProgress(iter, {
        persist: async (p: number) => {
            emitted.push(p);
        },
        now: () => Date.now(),
        debounceMs: 10,
    });
    // Should include 0 (first), 1,2,50,51,99,100 final (even if last already 100 ensure single)
    expect(emitted[0]).toBe(0);
    expect(emitted.includes(100)).toBeTrue();
    expect(emitted.filter((p) => p === 100).length).toBe(1);
    expect(emitted).toContain(51);
});

test('progress throttling time-based emission triggers when no delta', async () => {
    const emitted: number[] = [];
    const start = Date.now();
    let now = start;
    const iter = makeProgress([0, 0, 0, 0, 0, 100]);
    await __progressTest.throttleProgress(iter, {
        persist: async (p: number) => {
            emitted.push(p);
        },
        now: () => now,
        debounceMs: 50,
    });
    // Only first 0 emitted immediately, intermediate duplicates suppressed, final 100 forced
    expect(emitted).toEqual([0, 100]);
    // Now simulate with advancing time
    emitted.length = 0;
    now = start;
    const iter2 = makeProgress([0, 0, 0, 0, 50, 50, 100]);
    let step = 0;
    await __progressTest.throttleProgress(iter2, {
        persist: async (p: number) => {
            emitted.push(p);
        },
        now: () => {
            if (step++ > 0) now += 60;
            return now;
        },
        debounceMs: 50,
    });
    // Expect repeated 0s & 50 due to time-based emission (debounce exceeded) plus final 100
    expect(emitted).toEqual([0, 0, 0, 0, 50, 50, 100]);
});
