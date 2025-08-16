import { PgBossQueueAdapter } from '@clipper/queue';
import { requireEnv, createLogger, readEnv } from '@clipper/common';
import { startAsrWorker } from './asr';

const log = createLogger((readEnv('LOG_LEVEL') as any) || 'info').with({
    mod: 'asr.start',
});

const queue = new PgBossQueueAdapter({
    connectionString: requireEnv('DATABASE_URL'),
});

await startAsrWorker({ queue });

log.info('ASR worker started');
