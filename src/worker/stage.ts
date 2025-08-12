import { MetricsRegistry } from '@clipper/common/metrics';

export type StageErrorCode = 'timeout' | 'not_found' | 'network' | 'error';

function classifyError(e: any, custom?: (err: any) => string): StageErrorCode {
    try {
        if (custom) return (custom(e) as StageErrorCode) || 'error';
        const msg = String(e?.message || e || '').toLowerCase();
        if (/timeout/.test(msg)) return 'timeout';
        if (/not.?found|enoent/.test(msg)) return 'not_found';
        if (/network|econn|eai_again|enotfound/.test(msg)) return 'network';
        return 'error';
    } catch {
        return 'error';
    }
}

export interface WithStageOptions {
    classify?: (err: any) => string;
}

/**
 * Executes an async stage fn, recording latency & failures.
 * Metrics:
 *  - worker.stage_latency_ms{stage}
 *  - worker.stage_failures_total{stage,code}
 */
export async function withStage<T>(
    metrics: MetricsRegistry,
    stage: string,
    fn: () => Promise<T>,
    opts: WithStageOptions = {}
): Promise<T> {
    const start = performance.now();
    try {
        const res = await fn();
        metrics.observe('worker.stage_latency_ms', performance.now() - start, {
            stage,
        });
        return res;
    } catch (e) {
        metrics.observe('worker.stage_latency_ms', performance.now() - start, {
            stage,
        });
        const code = classifyError(e, opts.classify);
        metrics.inc('worker.stage_failures_total', 1, { stage, code });
        throw e;
    }
}

export { classifyError };
