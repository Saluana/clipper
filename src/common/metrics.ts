export type MetricLabels = Record<string, string | number>;

export interface Metrics {
    inc(name: string, value?: number, labels?: MetricLabels): void;
    observe(name: string, value: number, labels?: MetricLabels): void;
    snapshot(): MetricsSnapshot;
}

export interface MetricsSnapshot {
    counters: Record<string, number>;
    histograms: Record<
        string,
        {
            count: number;
            sum: number;
            min: number;
            max: number;
            p50: number;
            p90: number;
            p99: number;
        }
    >;
}

export class InMemoryMetrics implements Metrics {
    counters = new Map<string, number>();
    histograms = new Map<string, number[]>();
    inc(name: string, value = 1, labels?: MetricLabels) {
        const key = keyWithLabels(name, labels);
        this.counters.set(key, (this.counters.get(key) ?? 0) + value);
    }
    observe(name: string, value: number, labels?: MetricLabels) {
        const key = keyWithLabels(name, labels);
        const arr = this.histograms.get(key) ?? [];
        arr.push(value);
        this.histograms.set(key, arr);
    }
    snapshot(): MetricsSnapshot {
        const counters: Record<string, number> = {};
        for (const [k, v] of this.counters.entries()) counters[k] = v;
        const histograms: MetricsSnapshot['histograms'] = {};
        for (const [k, arr] of this.histograms.entries()) {
            if (!arr.length) continue;
            const sorted = [...arr].sort((a, b) => a - b);
            const pct = (p: number): number => {
                const idx = Math.min(
                    sorted.length - 1,
                    Math.max(0, Math.floor((p / 100) * sorted.length))
                );
                return sorted[idx] ?? sorted[sorted.length - 1] ?? 0;
            };
            histograms[k] = {
                count: arr.length,
                sum: arr.reduce((a, b) => a + b, 0),
                min: sorted[0]!,
                max: sorted[sorted.length - 1]!,
                p50: pct(50),
                p90: pct(90),
                p99: pct(99),
            };
        }
        return { counters, histograms };
    }
}

export const noopMetrics: Metrics = {
    inc() {},
    observe() {},
    snapshot() {
        return { counters: {}, histograms: {} };
    },
};

function keyWithLabels(name: string, labels?: MetricLabels) {
    if (!labels) return name;
    const parts = Object.entries(labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
    return `${name}{${parts}}`;
}
