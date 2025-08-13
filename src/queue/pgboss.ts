import PgBoss from 'pg-boss';
import { readEnv, readIntEnv } from '@clipper/common';
import type { QueueAdapter, QueueMessage, QueuePriority } from './types';
import { QUEUE_TOPIC_CLIPS } from './types';

const priorityMap: Record<QueuePriority, number> = {
    fast: 10,
    normal: 50,
    bulk: 90,
};

export class PgBossQueueAdapter implements QueueAdapter {
    private boss?: PgBoss;
    private topic: string;
    private dlqTopic: string;
    private metrics = {
        publishes: 0,
        claims: 0,
        completes: 0,
        retries: 0,
        errors: 0,
        dlq: 0,
    };

    constructor(
        private readonly opts: {
            connectionString: string;
            schema?: string;
            queueName?: string;
            concurrency?: number;
            visibilityTimeoutSec?: number;
            maxAttempts?: number;
        }
    ) {
        this.topic =
            opts.queueName ?? readEnv('QUEUE_NAME') ?? QUEUE_TOPIC_CLIPS;
        this.dlqTopic = `${this.topic}.dlq`;
    }

    async start() {
        if (this.boss) return;
        this.boss = new PgBoss({
            connectionString: this.opts.connectionString,
            schema: this.opts.schema ?? readEnv('PG_BOSS_SCHEMA') ?? 'pgboss',
        });
        this.boss.on('error', (err) => {
            // Increment error metric on boss-level errors
            this.metrics.errors++;
            // Avoid importing logger to keep package lean; rely on caller logs
            console.error('[pgboss] error', err);
        });
        await this.boss.start();
        // Ensure queues exist with basic policies
        const expireInSeconds = Math.max(
            1,
            Math.floor(
                Number(
                    readIntEnv(
                        'QUEUE_VISIBILITY_SEC',
                        this.opts.visibilityTimeoutSec ?? 90
                    )
                )
            )
        );
        const retryLimit = Number(
            readIntEnv('QUEUE_MAX_ATTEMPTS', this.opts.maxAttempts ?? 3)
        );
        try {
            await this.boss.createQueue(this.topic, {
                name: this.topic,
                expireInSeconds,
                retryLimit,
                deadLetter: this.dlqTopic,
            });
        } catch (err) {
            // Intentionally ignore errors if the queue already exists
            // console.error('Error creating queue:', err);
        }
        try {
            await this.boss.createQueue(this.dlqTopic, {
                name: this.dlqTopic,
                expireInSeconds: expireInSeconds * 2,
                retryLimit: 0,
            });
        } catch {}
    }

    async publish(
        msg: QueueMessage,
        opts?: { timeoutSec?: number }
    ): Promise<void> {
        if (!this.boss) await this.start();
        const expireInSeconds = Math.max(
            1,
            Math.floor(
                opts?.timeoutSec ??
                    Number(
                        readIntEnv(
                            'QUEUE_VISIBILITY_SEC',
                            this.opts.visibilityTimeoutSec ?? 90
                        )
                    )
            )
        );
        const attemptLimit = Number(
            readIntEnv('QUEUE_MAX_ATTEMPTS', this.opts.maxAttempts ?? 3)
        );
        const priority = priorityMap[msg.priority ?? 'normal'];
        await this.boss!.send(this.topic, msg as object, {
            priority,
            expireInSeconds,
            retryLimit: attemptLimit,
            retryBackoff: true,
            deadLetter: this.dlqTopic,
        });
        this.metrics.publishes++;
    }

    async consume(
        handler: (msg: QueueMessage) => Promise<void>
    ): Promise<void> {
        if (!this.boss) await this.start();
        const batchSize = Number(
            readIntEnv('QUEUE_CONCURRENCY', this.opts.concurrency ?? 4)
        );
        await this.boss!.work<QueueMessage>(
            this.topic,
            { batchSize },
            async (jobs) => {
                for (const job of jobs) {
                    this.metrics.claims++;
                    try {
                        await handler(job.data as QueueMessage);
                        this.metrics.completes++;
                    } catch (err) {
                        // A thrown error triggers retry/DLQ in pg-boss
                        this.metrics.retries++;
                        this.metrics.errors++;
                        throw err;
                    }
                }
                // Throw inside handler to trigger retry; returning resolves completions
            }
        );
    }

    /**
     * Adaptive consumption loop that only fetches jobs when capacityProvider() > 0.
     * Avoids over-claiming jobs whose work would just sit waiting on a local semaphore.
     * Optional optimization (enabled by caller explicitly using this API).
     */
    async adaptiveConsume(
        handler: (msg: QueueMessage) => Promise<void>,
        capacityProvider: () => number,
        opts?: { idleDelayMs?: number; maxBatch?: number }
    ) {
        if (!this.boss) await this.start();
        const idleDelayMs = opts?.idleDelayMs ?? 250;
        const maxConfigured = Number(
            readIntEnv('QUEUE_CONCURRENCY', this.opts.concurrency ?? 4)
        );
        const maxBatch = opts?.maxBatch ?? maxConfigured;
        // Loop forever; caller governs process lifetime.
        // We intentionally do not use boss.work here so we control fetch timing.
        // eslint-disable-next-line no-constant-condition
        while (true) {
            try {
                const cap = capacityProvider();
                if (cap <= 0) {
                    await new Promise((r) => setTimeout(r, idleDelayMs));
                    continue;
                }
                const batchSize = Math.min(cap, maxBatch);
                const jobs = await this.boss!.fetch(this.topic, {
                    batchSize,
                } as any);
                if (!jobs || jobs.length === 0) {
                    await new Promise((r) => setTimeout(r, idleDelayMs));
                    continue;
                }
                this.metrics.claims += jobs.length;
                for (const job of jobs) {
                    // Fire and forget each job; completion/failure ack individually.
                    (async () => {
                        try {
                            await handler(job.data as QueueMessage);
                            await this.boss!.complete(
                                job.name,
                                job.id,
                                (job as any).data || {}
                            );
                            this.metrics.completes++;
                        } catch (err) {
                            this.metrics.retries++;
                            this.metrics.errors++;
                            try {
                                await this.boss!.fail(
                                    job.name,
                                    job.id,
                                    (job as any).data || {}
                                );
                            } catch {}
                        }
                    })();
                }
            } catch (e) {
                this.metrics.errors++;
                // Backoff briefly on errors
                await new Promise((r) => setTimeout(r, idleDelayMs));
            }
        }
    }

    // Optional multi-topic methods (for subsystems like ASR)
    async publishTo(
        topic: string,
        msg: object,
        opts?: { timeoutSec?: number }
    ) {
        if (!this.boss) await this.start();
        const expireInSeconds = Math.max(
            1,
            Math.floor(
                opts?.timeoutSec ??
                    Number(
                        readIntEnv(
                            'QUEUE_VISIBILITY_SEC',
                            this.opts.visibilityTimeoutSec ?? 90
                        )
                    )
            )
        );
        const retryLimit = Number(
            readIntEnv('QUEUE_MAX_ATTEMPTS', this.opts.maxAttempts ?? 3)
        );
        const dlq = `${topic}.dlq`;
        try {
            await this.boss!.createQueue(topic, {
                name: topic,
                expireInSeconds,
                retryLimit,
                deadLetter: dlq,
            });
        } catch {}
        try {
            await this.boss!.createQueue(dlq, {
                name: dlq,
                expireInSeconds: expireInSeconds * 2,
                retryLimit: 0,
            });
        } catch {}
        await this.boss!.send(topic, msg, {
            expireInSeconds,
            retryLimit,
            retryBackoff: true,
            deadLetter: dlq,
        });
        this.metrics.publishes++;
    }

    async consumeFrom(topic: string, handler: (msg: any) => Promise<void>) {
        if (!this.boss) await this.start();
        const batchSize = Number(
            readIntEnv('QUEUE_CONCURRENCY', this.opts.concurrency ?? 4)
        );
        await this.boss!.work<any>(topic, { batchSize }, async (jobs) => {
            for (const job of jobs) {
                this.metrics.claims++;
                try {
                    await handler(job.data as any);
                    this.metrics.completes++;
                } catch (err) {
                    this.metrics.retries++;
                    this.metrics.errors++;
                    throw err;
                }
            }
        });
    }

    async shutdown(): Promise<void> {
        if (this.boss) {
            await this.boss.stop();
            this.boss = undefined;
        }
    }

    async health(): Promise<{ ok: boolean; error?: string }> {
        try {
            if (!this.boss) await this.start();
            // Simple ping by fetching the state; if it throws, not healthy
            // getQueue takes a name and returns settings; use topic
            await this.boss!.getQueue(this.topic);
            return { ok: true };
        } catch (e) {
            return {
                ok: false,
                error: e instanceof Error ? e.message : String(e),
            };
        }
    }

    getMetrics() {
        return { ...this.metrics };
    }
}
