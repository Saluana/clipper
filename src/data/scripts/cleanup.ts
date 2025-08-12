import { cleanupExpiredJobs, cleanupExpiredAsrJobs } from '../cleanup';
import { createSupabaseStorageRepo } from '../storage';
import { readEnv, readIntEnv } from '@clipper/common';
import { createLogger } from '@clipper/common/logger';

const DRY_RUN =
    (readEnv('CLEANUP_DRY_RUN') ?? 'true').toLowerCase() !== 'false';
const BATCH = readIntEnv('CLEANUP_BATCH_SIZE', 100) ?? 100;
const RATE_DELAY = readIntEnv('CLEANUP_RATE_LIMIT_MS', 0) ?? 0;
const USE_STORAGE =
    (readEnv('CLEANUP_STORAGE') ?? 'true').toLowerCase() === 'true';

async function main() {
    const logger = createLogger((readEnv('LOG_LEVEL') as any) ?? 'info');
    const storage = USE_STORAGE
        ? (() => {
              try {
                  return createSupabaseStorageRepo();
              } catch {
                  return null;
              }
          })()
        : null;
    const clipRes = await cleanupExpiredJobs({
        dryRun: DRY_RUN,
        batchSize: BATCH,
        rateLimitDelayMs: RATE_DELAY,
        storage,
        logger,
    });
    const asrRes = await cleanupExpiredAsrJobs({
        dryRun: DRY_RUN,
        batchSize: BATCH,
        rateLimitDelayMs: RATE_DELAY,
        storage,
        logger,
    });
    logger.info('cleanup finished', { clip: clipRes, asr: asrRes } as any);
}

if (import.meta.main) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
