import { MetricsRegistry } from './metrics';

export interface ExternalCallOptions {
    dep: 'yt_dlp' | 'ffprobe' | 'storage' | 'asr';
    op: string; // short operation label
    classifyError?: (err: any) => string | undefined;
    timeoutMs?: number; // optional hard timeout
}

export async function withExternal<T>(
    metrics: MetricsRegistry,
    opts: ExternalCallOptions,
    fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
    const { dep, op } = opts;
    const start = performance.now();
    const controller = new AbortController();
    let timeout: any;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
        timeout = setTimeout(
            () => controller.abort(),
            opts.timeoutMs
        ).unref?.();
    }
    try {
        const res = await fn(controller.signal);
        metrics.inc('external.calls_total', 1, { dep, op, status: 'ok' });
        metrics.observe('external.call_latency_ms', performance.now() - start, {
            dep,
            op,
        });
        return res;
    } catch (e) {
        const code = classifyExternalError(e, opts.classifyError);
        metrics.inc('external.calls_total', 1, {
            dep,
            op,
            status: 'err',
            code,
        });
        metrics.observe('external.call_latency_ms', performance.now() - start, {
            dep,
            op,
        });
        throw e;
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

function classifyExternalError(
    e: any,
    custom?: (err: any) => string | undefined
): string {
    try {
        if (custom) {
            const c = custom(e);
            if (c) return c;
        }
        const msg = String(e?.message || e || '').toLowerCase();
        if (/timeout|etimedout|abort/.test(msg)) return 'timeout';
        if (/not.?found|enoent|404/.test(msg)) return 'not_found';
        if (/unauth|forbidden|401|403/.test(msg)) return 'auth';
        if (/network|econn|eai_again|enotfound/.test(msg)) return 'network';
        if (/too large|payload|413/.test(msg)) return 'too_large';
        return 'error';
    } catch {
        return 'error';
    }
}

export { classifyExternalError };
