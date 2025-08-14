import { createDb } from './db/connection';
import { jobs, asrJobs, asrArtifacts } from './db/schema';
import { lte, isNotNull, and, eq, desc } from 'drizzle-orm';
import type { StorageRepo } from './storage';
import type { Logger } from '../common';
import { createLogger, noopMetrics, type Metrics } from '../common';

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
        const keys = [
            r.resultVideoKey,
            // include burned video artifact if present
            (r as any).resultVideoBurnedKey,
            r.resultSrtKey,
        ].filter((k): k is string => !!k);
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

// --- ASR Cleanup -----------------------------------------------------------

export type AsrCleanupItem = {
    asrJobId: string;
    artifactKeys: string[];
};

export type AsrCleanupResult = {
    scanned: number; // expired ASR jobs found
    deletedAsrJobs: number;
    deletedArtifacts: number; // storage objects removed
    items: AsrCleanupItem[];
    errors: Array<{
        asrJobId: string;
        stage: 'storage' | 'db';
        error: string;
    }>;
};

export async function cleanupExpiredAsrJobs(
    opts: CleanupOptions = {}
): Promise<AsrCleanupResult> {
    const db = createDb();
    const now = opts.now ?? new Date();
    const limit = opts.batchSize ?? 100;
    const dryRun = opts.dryRun ?? true;
    const delay = opts.rateLimitDelayMs ?? 0;
    const storage = opts.storage ?? null;
    const logger =
        opts.logger ?? createLogger('info').with({ comp: 'cleanup.asr' });
    const metrics = opts.metrics ?? noopMetrics;

    // Fetch expired ASR jobs
    const rows = await db
        .select()
        .from(asrJobs)
        .where(and(isNotNull(asrJobs.expiresAt), lte(asrJobs.expiresAt, now)))
        .orderBy(desc(asrJobs.expiresAt))
        .limit(limit);

    const result: AsrCleanupResult = {
        scanned: rows.length,
        deletedAsrJobs: 0,
        deletedArtifacts: 0,
        items: [],
        errors: [],
    };

    for (const r of rows) {
        const asrJobId = r.id as string;
        // Load artifacts for storage keys
        let artifactsRows: Array<{ storageKey: string | null }> = [];
        try {
            artifactsRows = await db
                .select({ storageKey: asrArtifacts.storageKey })
                .from(asrArtifacts)
                .where(eq(asrArtifacts.asrJobId, asrJobId));
        } catch (e) {
            // Non-fatal; proceed with empty list
            logger.warn('artifact list failed', { asrJobId });
        }
        const artifactKeys = artifactsRows
            .map((a) => a.storageKey)
            .filter((k): k is string => !!k);
        result.items.push({ asrJobId, artifactKeys });

        if (dryRun) continue;

        if (storage) {
            for (const key of artifactKeys) {
                try {
                    await storage.remove(key);
                    result.deletedArtifacts++;
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    result.errors.push({
                        asrJobId,
                        stage: 'storage',
                        error: msg,
                    });
                    logger.warn('artifact delete failed', {
                        asrJobId,
                        key,
                        msg,
                    });
                }
                if (delay > 0) await sleep(delay);
            }
        }

        // Delete ASR job (cascades artifacts table rows)
        try {
            await db.delete(asrJobs).where(eq(asrJobs.id, asrJobId));
            result.deletedAsrJobs++;
            metrics.inc('cleanup.asrJobs.deleted', 1);
            logger.info('asr job deleted', { asrJobId });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            result.errors.push({
                asrJobId,
                stage: 'db',
                error: msg,
            });
            logger.error('asr db delete failed', { asrJobId, msg });
        }
        if (delay > 0) await sleep(delay);
    }
    return result;
}

function sleep(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
}
