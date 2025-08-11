export type MetricLabels = Record<string, string | number>;

export interface Metrics {
    inc(name: string, value?: number, labels?: MetricLabels): void;
    observe(name: string, value: number, labels?: MetricLabels): void;
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
}

export const noopMetrics: Metrics = {
    inc() {},
    observe() {},
};

function keyWithLabels(name: string, labels?: MetricLabels) {
    if (!labels) return name;
    const parts = Object.entries(labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
    return `${name}{${parts}}`;
}
