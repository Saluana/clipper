import { createDb } from './db/connection';
import { jobs } from './db/schema';
import { lte, isNotNull, and, eq, desc } from 'drizzle-orm';
import type { StorageRepo } from './storage';
import type { Logger } from '@clipper/common';
import { createLogger, noopMetrics, type Metrics } from '@clipper/common';

export type CleanupOptions = {
    now?: Date;
    batchSize?: number;
    dryRun?: boolean;
    rateLimitDelayMs?: number;
    storage?: StorageRepo | null;
    logger?: Logger;
    metrics?: Metrics;
};

export type CleanupItem = {
    jobId: string;
    resultKeys: string[];
};

export type CleanupResult = {
    scanned: number;
    deletedJobs: number;
    deletedObjects: number;
    items: CleanupItem[];
    errors: Array<{ jobId: string; stage: 'storage' | 'db'; error: string }>;
};

export async function cleanupExpiredJobs(
    opts: CleanupOptions = {}
): Promise<CleanupResult> {
    const db = createDb();
    const now = opts.now ?? new Date();
    const limit = opts.batchSize ?? 100;
    const dryRun = opts.dryRun ?? true;
    const delay = opts.rateLimitDelayMs ?? 0;
    const storage = opts.storage ?? null;
    const logger =
        opts.logger ?? createLogger('info').with({ comp: 'cleanup' });
    const metrics = opts.metrics ?? noopMetrics;

    const rows = await db
        .select()
        .from(jobs)
        .where(and(isNotNull(jobs.expiresAt), lte(jobs.expiresAt, now)))
        .orderBy(desc(jobs.expiresAt))
        .limit(limit);

    const result: CleanupResult = {
        scanned: rows.length,
        deletedJobs: 0,
        deletedObjects: 0,
        items: [],
        errors: [],
    };

    for (const r of rows) {
        const jobId = r.id as string;
        const keys = [r.resultVideoKey, r.resultSrtKey].filter(
            (k): k is string => !!k
        );
        result.items.push({ jobId, resultKeys: keys });

        if (dryRun) continue;

        // remove storage objects if configured
        if (storage) {
            for (const key of keys) {
                try {
                    await storage.remove(key);
                    result.deletedObjects++;
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    result.errors.push({ jobId, stage: 'storage', error: msg });
                    logger?.warn('storage delete failed', { jobId, key, msg });
                }
                if (delay > 0) await sleep(delay);
            }
        }

        // delete the job (cascades events)
        try {
            await db.delete(jobs).where(eq(jobs.id, jobId));
            result.deletedJobs++;
            metrics.inc('cleanup.jobs.deleted', 1);
            logger.info('job deleted', { jobId });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            result.errors.push({ jobId, stage: 'db', error: msg });
            logger?.error('db delete failed', { jobId, msg });
        }

        if (delay > 0) await sleep(delay);
    }

    return result;
}

function sleep(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
}
