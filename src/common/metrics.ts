// Core metrics primitives & registry
export type MetricLabels = Record<string, string | number>;

export interface MetricsSnapshot {
    counters: Record<string, number>;
    histograms: Record<string, HistogramSnapshot>;
    gauges?: Record<string, number>;
}

export interface HistogramSnapshot {
    count: number;
    sum: number;
    min: number;
    max: number;
    p50: number;
    p90: number;
    p99: number;
    buckets: { le: number; count: number }[]; // cumulative counts per bucket (incl +Inf)
}

interface RegistryOpts {
    maxLabelSetsPerMetric?: number; // cardinality guardrail
    defaultHistogramBuckets?: number[]; // ascending, excludes +Inf
}

// Internal helpers
function keyWithLabels(name: string, labels?: MetricLabels) {
    if (!labels) return name;
    const parts = Object.entries(labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
    return `${name}{${parts}}`;
}

function labelsKey(labels?: MetricLabels) {
    if (!labels) return '__no_labels__';
    return Object.entries(labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('|');
}

class Counter {
    private values = new Map<string, number>();
    constructor(
        private readonly name: string,
        private readonly maxLabelSets: number
    ) {}
    inc(by: number, labels?: MetricLabels) {
        const k = labelsKey(labels);
        if (!this.values.has(k) && this.values.size >= this.maxLabelSets)
            return; // enforce limit silently
        this.values.set(k, (this.values.get(k) ?? 0) + by);
    }
    snapshot() {
        const out: Record<string, number> = {};
        for (const [lk, v] of this.values) {
            const labelObj: MetricLabels | undefined =
                lk === '__no_labels__'
                    ? undefined
                    : Object.fromEntries(
                          lk.split('|').map((kv) => kv.split('='))
                      );
            out[keyWithLabels(this.name, labelObj)] = v;
        }
        return out;
    }
}

class Gauge {
    private values = new Map<string, number>();
    constructor(
        private readonly name: string,
        private readonly maxLabelSets: number
    ) {}
    set(value: number, labels?: MetricLabels) {
        const k = labelsKey(labels);
        if (!this.values.has(k) && this.values.size >= this.maxLabelSets)
            return;
        this.values.set(k, value);
    }
    snapshot() {
        const out: Record<string, number> = {};
        for (const [lk, v] of this.values) {
            const labelObj: MetricLabels | undefined =
                lk === '__no_labels__'
                    ? undefined
                    : Object.fromEntries(
                          lk.split('|').map((kv) => kv.split('='))
                      );
            out[keyWithLabels(this.name, labelObj)] = v;
        }
        return out;
    }
}

class Histogram {
    private labelSets = new Map<
        string,
        {
            values: number[]; // retain raw for quantiles (small scale ok)
            buckets: number[]; // cumulative counts (length = bucketBounds.length + 1)
        }
    >();
    constructor(
        private readonly name: string,
        private readonly bounds: number[], // ascending, excludes +Inf
        private readonly maxLabelSets: number
    ) {}
    observe(value: number, labels?: MetricLabels) {
        const lk = labelsKey(labels);
        let set = this.labelSets.get(lk);
        if (!set) {
            if (this.labelSets.size >= this.maxLabelSets) return; // enforce limit
            set = {
                values: [],
                buckets: new Array(this.bounds.length + 1).fill(0),
            };
            this.labelSets.set(lk, set);
        }
        set.values.push(value);
        // find bucket index
        let idx = this.bounds.findIndex((b) => value <= b);
        if (idx === -1) idx = this.bounds.length; // +Inf bucket
        for (let i = idx; i < set.buckets.length; i++) {
            // cumulative increments from bucket idx to end
            set.buckets[i] = (set.buckets[i] || 0) + 1;
        }
    }
    snapshot(): Record<string, HistogramSnapshot> {
        const out: Record<string, HistogramSnapshot> = {};
        for (const [lk, data] of this.labelSets) {
            if (!data.values.length) continue;
            const sorted = [...data.values].sort((a, b) => a - b);
            const pick = (p: number): number => {
                if (!sorted.length) return 0;
                const idx = Math.min(
                    sorted.length - 1,
                    Math.max(0, Math.floor((p / 100) * sorted.length))
                );
                return sorted[idx] ?? sorted[sorted.length - 1] ?? 0;
            };
            const labelObj: MetricLabels | undefined =
                lk === '__no_labels__'
                    ? undefined
                    : Object.fromEntries(
                          lk.split('|').map((kv) => kv.split('='))
                      );
            const buckets = this.bounds.map((b, i) => ({
                le: b,
                count: data.buckets[i] || 0,
            }));
            buckets.push({
                le: Infinity,
                count: data.buckets[data.buckets.length - 1] || 0,
            });
            out[keyWithLabels(this.name, labelObj)] = {
                count: data.values.length,
                sum: data.values.reduce((a, b) => a + b, 0),
                min: sorted[0]!,
                max: sorted[sorted.length - 1]!,
                p50: pick(50),
                p90: pick(90),
                p99: pick(99),
                buckets,
            };
        }
        return out;
    }
}

export class MetricsRegistry {
    private counters = new Map<string, Counter>();
    private histograms = new Map<string, Histogram>();
    private gauges = new Map<string, Gauge>();
    private maxLabelSetsPerMetric: number;
    private defaultHistogramBuckets: number[];
    constructor(opts: RegistryOpts = {}) {
        this.maxLabelSetsPerMetric = opts.maxLabelSetsPerMetric ?? 50;
        this.defaultHistogramBuckets = opts.defaultHistogramBuckets ?? [
            5, 10, 25, 50, 100, 250, 500, 1000,
        ];
    }
    counter(name: string) {
        let c = this.counters.get(name);
        if (!c) {
            c = new Counter(name, this.maxLabelSetsPerMetric);
            this.counters.set(name, c);
        }
        return c;
    }
    histogram(name: string, buckets?: number[]) {
        let h = this.histograms.get(name);
        if (!h) {
            h = new Histogram(
                name,
                [...(buckets ?? this.defaultHistogramBuckets)].sort(
                    (a, b) => a - b
                ),
                this.maxLabelSetsPerMetric
            );
            this.histograms.set(name, h);
        }
        return h;
    }
    gauge(name: string) {
        let g = this.gauges.get(name);
        if (!g) {
            g = new Gauge(name, this.maxLabelSetsPerMetric);
            this.gauges.set(name, g);
        }
        return g;
    }
    // Convenience pass-throughs for legacy style usage
    inc(name: string, value = 1, labels?: MetricLabels) {
        this.counter(name).inc(value, labels);
    }
    observe(name: string, value: number, labels?: MetricLabels) {
        this.histogram(name).observe(value, labels);
    }
    setGauge(name: string, value: number, labels?: MetricLabels) {
        this.gauge(name).set(value, labels);
    }
    snapshot(): MetricsSnapshot {
        const counters: Record<string, number> = {};
        for (const [, c] of this.counters)
            Object.assign(counters, c.snapshot());
        const histograms: Record<string, HistogramSnapshot> = {};
        for (const [, h] of this.histograms)
            Object.assign(histograms, h.snapshot());
        const gauges: Record<string, number> = {};
        for (const [, g] of this.gauges) Object.assign(gauges, g.snapshot());
        return { counters, histograms, gauges };
    }
}

// Backwards-compatible export used across codebase
export class InMemoryMetrics extends MetricsRegistry {}

export const noopMetrics = new (class extends MetricsRegistry {
    override inc() {}
    override observe() {}
    override setGauge() {}
    override snapshot(): MetricsSnapshot {
        return { counters: {}, histograms: {}, gauges: {} };
    }
})();

// Lightweight interface type used by higher-level modules to allow dependency injection
// Accept any implementation that matches the core surface (inc/observe/setGauge/snapshot)
export type Metrics = {
    inc(name: string, value?: number, labels?: MetricLabels): void;
    observe(name: string, value: number, labels?: MetricLabels): void;
    setGauge(name: string, value: number, labels?: MetricLabels): void;
    snapshot(): MetricsSnapshot;
};

// Route normalization helper (/:id placeholder for dynamic segments)
// Replaces UUID v4 and purely numeric path segments with :id
export function normalizeRoute(path: string) {
    const pathname = path.split('?')[0] || '/';
    return (
        (pathname || '/')
            .split('/')
            .map((seg) => {
                if (!seg) return seg; // preserve leading ''
                if (/^[0-9]+$/.test(seg)) return ':id';
                if (
                    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(
                        seg
                    )
                )
                    return ':id';
                return seg;
            })
            .join('/') || '/'
    );
}
