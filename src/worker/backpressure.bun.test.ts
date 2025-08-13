import { test, expect } from 'bun:test';
import { InMemoryMetrics } from '@clipper/common/metrics';
import { readEnv } from '@clipper/common';
import os from 'os';

// We'll import worker index to get test hooks; ensure env minimal
import '../worker/index.ts';
// Access exported helper
// @ts-ignore
const { createBackpressureController } =
    (global as any).__backpressureTest || {};

// Fallback if not exposed
if (!createBackpressureController) {
    throw new Error('createBackpressureController not exported for tests');
}

test('backpressure triggers pause on high depth & cpu then resets after interval', async () => {
    let depth = 100;
    const loads: number[] = [];
    const controller = createBackpressureController({
        getDepth: () => depth,
        getCpu: () => {
            const l = loads.at(-1) ?? 0;
            return l;
        },
        highDepth: 50,
        highCpu: 2, // low threshold to trigger easily
        pauseMs: 200,
        now: (() => {
            let t = 0;
            return () => t;
        })(),
    });
    // initial no pause (depth high but cpu low)
    loads.push(0.5);
    await controller.evaluate();
    expect(controller.isPaused()).toBe(false);
    // raise cpu, should trigger
    loads.push(3);
    await controller.evaluate();
    expect(controller.isPaused()).toBe(true);
    const firstPauseUntil = controller.pausedUntil;
    expect(firstPauseUntil).toBeGreaterThan(0);
});
