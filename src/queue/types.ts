export type QueuePriority = 'fast' | 'normal' | 'bulk';

export interface QueueMessage {
    jobId: string;
    priority?: QueuePriority;
}

export interface QueueAdapter {
    publish(msg: QueueMessage, opts?: { timeoutSec?: number }): Promise<void>;
    consume(handler: (msg: QueueMessage) => Promise<void>): Promise<void>;
    // Optional multi-topic API for subsystems (e.g., ASR)
    publishTo?(
        topic: string,
        msg: object,
        opts?: { timeoutSec?: number }
    ): Promise<void>;
    consumeFrom?(
        topic: string,
        handler: (msg: any) => Promise<void>
    ): Promise<void>;
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

// Queue topics used in the system
export const QUEUE_TOPIC_CLIPS = 'clips';
export const QUEUE_TOPIC_ASR = 'asr';
