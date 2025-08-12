import { MetricsRegistry } from './metrics';
import { readEnv } from './env';

export interface ResourceSamplerOptions {
    metrics: MetricsRegistry;
    intervalMs?: number; // default 5000
    scratchDir?: string; // default from SCRATCH_DIR or /tmp/ytc
    getScratchUsage?: () => Promise<{
        usedBytes: number;
        capacityBytes?: number;
    }>; // test override
    now?: () => number; // test clock
}

/**
 * ResourceSampler periodically records process & system level metrics:
 *  - proc.memory_rss_mb (gauge)
 *  - scratch.disk_used_pct (gauge)   ( -1 when capacity unknown )
 *  - event_loop.lag_ms (histogram)
 */
export class ResourceSampler {
    private readonly metrics: MetricsRegistry;
    private readonly intervalMs: number;
    private readonly scratchDir: string;
    private timer: any = null;
    private lastTick: number | null = null;
    private readonly getScratchUsage?: () => Promise<{
        usedBytes: number;
        capacityBytes?: number;
    }>;
    private readonly now: () => number;

    constructor(opts: ResourceSamplerOptions) {
        this.metrics = opts.metrics;
        this.intervalMs = Math.max(1000, opts.intervalMs ?? 5000);
        this.scratchDir = (
            opts.scratchDir ||
            readEnv('SCRATCH_DIR') ||
            '/tmp/ytc'
        ).replace(/\/$/, '');
        this.getScratchUsage = opts.getScratchUsage;
        this.now = opts.now || (() => performance.now());
    }

    start() {
        if (this.timer) return;
        this.lastTick = this.now();
        this.timer = setInterval(
            () => this.tick().catch(() => {}),
            this.intervalMs
        );
        (this.timer as any).unref?.();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    async tick() {
        const now = this.now();
        if (this.lastTick != null) {
            const expected = this.lastTick + this.intervalMs;
            let lag = now - expected;
            if (lag < 0) lag = 0;
            this.metrics.observe('event_loop.lag_ms', lag);
        }
        this.lastTick = now;
        this.sampleMemory();
        await this.sampleScratch();
    }

    private sampleMemory() {
        try {
            const rss = (process.memoryUsage?.().rss ?? 0) / (1024 * 1024);
            this.metrics.setGauge('proc.memory_rss_mb', Number(rss.toFixed(2)));
        } catch {}
    }

    private async sampleScratch() {
        try {
            const usage = this.getScratchUsage
                ? await this.getScratchUsage()
                : await defaultScratchUsage(this.scratchDir);
            const { usedBytes, capacityBytes } = usage;
            if (capacityBytes && capacityBytes > 0) {
                const pct = (usedBytes / capacityBytes) * 100;
                this.metrics.setGauge(
                    'scratch.disk_used_pct',
                    Number(pct.toFixed(2))
                );
            } else {
                this.metrics.setGauge('scratch.disk_used_pct', -1);
            }
        } catch {
            this.metrics.setGauge('scratch.disk_used_pct', -1);
        }
    }
}

async function defaultScratchUsage(
    dir: string
): Promise<{ usedBytes: number; capacityBytes?: number }> {
    // Fast path: if directory doesn't exist, treat as empty
    let usedBytes = 0;
    try {
        const proc = Bun.spawn(
            ['find', dir, '-type', 'f', '-maxdepth', '4', '-printf', '%s\n'],
            { stdout: 'pipe', stderr: 'ignore' }
        );
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        usedBytes = out
            .split(/\n+/)
            .filter(Boolean)
            .reduce(
                (a, s) => (Number.isFinite(Number(s)) ? a + Number(s) : a),
                0
            );
    } catch {}
    let capacityBytes: number | undefined;
    try {
        const proc = Bun.spawn(['df', '-k', dir], {
            stdout: 'pipe',
            stderr: 'ignore',
        });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        const lines = out.trim().split(/\n+/);
        if (lines.length >= 2) {
            const second = lines[1] || '';
            const parts = second.split(/\s+/);
            if (parts.length >= 2) {
                const sizeKb = Number(parts[1]);
                if (Number.isFinite(sizeKb)) capacityBytes = sizeKb * 1024;
            }
        }
    } catch {}
    return { usedBytes, capacityBytes };
}

export function startResourceSampler(
    metrics: MetricsRegistry,
    opts: Partial<ResourceSamplerOptions> = {}
) {
    const sampler = new ResourceSampler({ metrics, ...opts });
    sampler.start();
    return sampler;
}
