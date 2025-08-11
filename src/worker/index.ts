import { createLogger, readEnv, requireEnv } from '@clipper/common';
import { DrizzleJobsRepo, DrizzleJobEventsRepo, createDb } from '@clipper/data';
import { PgBossQueueAdapter } from '@clipper/queue';

const log = createLogger((readEnv('LOG_LEVEL') as any) || 'info').with({
    mod: 'worker',
});

const jobs = new DrizzleJobsRepo(createDb());
const events = new DrizzleJobEventsRepo(createDb());
const queue = new PgBossQueueAdapter({
    connectionString: requireEnv('DATABASE_URL'),
});

async function main() {
    await queue.start();
    await queue.consume(async ({ jobId }: { jobId: string }) => {
        // idempotency: if already done, short-circuit
        const row = await jobs.get(jobId);
        if (!row) {
            log.warn('job not found', { jobId });
            return;
        }
        if (row.status === 'done') return;

        await jobs.update(jobId, { status: 'processing', progress: 5 });
        await events.add({
            jobId,
            ts: new Date().toISOString(),
            type: 'processing',
        });

        // simulate work & progress updates
        await jobs.update(jobId, { progress: 50 });
        await events.add({
            jobId,
            ts: new Date().toISOString(),
            type: 'progress',
            data: { pct: 50, stage: 'trim' },
        });

        await jobs.update(jobId, { progress: 100, status: 'done' });
        await events.add({ jobId, ts: new Date().toISOString(), type: 'done' });
    });
}

if (import.meta.main) {
    const run = async () => {
        try {
            await main();
        } catch (e) {
            log.error('worker crashed', { err: String(e) });
            process.exit(1);
        }
    };
    const stop = async () => {
        log.info('worker stopping');
        await queue.shutdown();
        process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    run();
}
