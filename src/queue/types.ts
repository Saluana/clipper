export type QueuePriority = 'fast' | 'normal' | 'bulk';

export interface QueueMessage {
    jobId: string;
    priority?: QueuePriority;
}

export interface QueueAdapter {
    publish(msg: QueueMessage, opts?: { timeoutSec?: number }): Promise<void>;
    consume(handler: (msg: QueueMessage) => Promise<void>): Promise<void>;
    shutdown(): Promise<void>;
    start(): Promise<void>;
    health(): Promise<{ ok: boolean; error?: string }>;
    getMetrics(): {
        publishes: number;
        claims: number;
        completes: number;
        retries: number;
        errors: number;
        dlq: number;
    };
}
