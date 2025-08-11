import { PgBossQueueAdapter } from './pgboss';
import { requireEnv } from '@clipper/common';

async function main() {
    const jobId = process.argv[2] || process.env.JOB_ID;
    if (!jobId) {
        console.error('Usage: bun src/publish.ts <jobId> or JOB_ID=<id>');
        process.exit(1);
    }
    const queue = new PgBossQueueAdapter({
        connectionString: requireEnv('DATABASE_URL'),
    });
    await queue.publish({ jobId, priority: 'normal' });
    console.log('[publish] sent', { jobId });
    await queue.shutdown();
}

if (import.meta.main) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
