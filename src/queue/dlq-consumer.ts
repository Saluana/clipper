import PgBoss from 'pg-boss';
import {
    createLogger,
    type LogLevel,
    readEnv,
    readIntEnv,
    requireEnv,
} from '@clipper/common';

const envLevel = readEnv('LOG_LEVEL');
const level: LogLevel =
    envLevel === 'debug' ||
    envLevel === 'info' ||
    envLevel === 'warn' ||
    envLevel === 'error'
        ? envLevel
        : 'info';
const log = createLogger(level).with({ mod: 'queue-dlq' });

export async function startDlqConsumer(opts?: {
    connectionString?: string;
    schema?: string;
    queueName?: string;
    concurrency?: number;
}) {
    const connectionString =
        opts?.connectionString || requireEnv('DATABASE_URL');
    const schema = opts?.schema || readEnv('PG_BOSS_SCHEMA') || 'pgboss';
    const topic = (opts?.queueName ||
        readEnv('QUEUE_NAME') ||
        'clips') as string;
    const dlqTopic = `${topic}.dlq`;
    const concurrency = Number(
        opts?.concurrency || readIntEnv('QUEUE_CONCURRENCY', 2)
    );

    const boss = new PgBoss({ connectionString, schema });
    await boss.start();
    log.info('DLQ consumer started', { dlqTopic, concurrency });

    await boss.work(dlqTopic, { batchSize: concurrency }, async (jobs) => {
        for (const job of jobs) {
            const payload = job.data as Record<string, unknown>;
            log.error('DLQ message received', { jobId: job.id, payload });
            // TODO: integrate alerting (pager/email/webhook) here if desired
        }
    });

    return async () => {
        log.info('DLQ consumer stopping');
        await boss.stop();
    };
}

// If executed directly (bun src/queue/dlq-consumer.ts), start the consumer
if (import.meta.main) {
    const stop = await startDlqConsumer().catch((err) => {
        log.error('Failed to start DLQ consumer', { err: String(err) });
        process.exit(1);
    });

    const shutdown = async (signal: string) => {
        try {
            log.info('Shutting down DLQ consumer', { signal });
            await stop?.();
        } finally {
            process.exit(0);
        }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Keep process alive
    await new Promise(() => {});
}
