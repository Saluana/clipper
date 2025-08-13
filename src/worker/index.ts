import {
    createLogger,
    readEnv,
    requireEnv,
    fromException,
} from '@clipper/common';
import {
    DrizzleJobsRepo,
    DrizzleJobEventsRepo,
    DrizzleAsrJobsRepo,
    createDb,
    resolveUploadSource,
    resolveYouTubeSource,
    createSupabaseStorageRepo,
    storageKeys,
} from '@clipper/data';
import { PgBossQueueAdapter } from '@clipper/queue';
import { BunClipper } from '@clipper/ffmpeg';
import { inArray, and, eq, lt, gte, sql } from 'drizzle-orm';
import { jobEvents, jobs as jobsTable } from '@clipper/data/db/schema';
import { AsrFacade } from '@clipper/asr/facade';
import { InMemoryMetrics } from '@clipper/common/metrics';
import { withStage } from './stage';
export * from './asr.ts';

const log = createLogger((readEnv('LOG_LEVEL') as any) || 'info').with({
    mod: 'worker',
});

const metrics = new InMemoryMetrics();
const sharedDb = createDb();
const jobs = new DrizzleJobsRepo(sharedDb, metrics);
const events = new DrizzleJobEventsRepo(sharedDb, metrics);
const queue = new PgBossQueueAdapter({
    connectionString: requireEnv('DATABASE_URL'),
});
const clipper = new BunClipper();
const storage = (() => {
    try {
        return createSupabaseStorageRepo();
    } catch (e) {
        log.warn('storage repo init failed (uploads will fail)', {
            error: String(e),
        });
        return null as any;
    }
})();
const asrFacade = new AsrFacade({
    asrJobs: new DrizzleAsrJobsRepo(sharedDb, metrics),
});

// Active job tracking for batch heartbeat (Req 2.1)
const activeJobs = new Set<string>();
let shuttingDown = false;

interface HeartbeatLoopOpts {
    intervalMs?: number;
    updater?: (ids: string[], now: Date) => Promise<void>;
    onWarn?: (failures: number, error: unknown) => void;
}

function startHeartbeatLoop(opts: HeartbeatLoopOpts = {}) {
    const intervalMs =
        opts.intervalMs ??
        Number(readEnv('WORKER_HEARTBEAT_INTERVAL_MS') || 10_000);
    let stopped = false;
    let consecutiveFailures = 0;
    const updater =
        opts.updater ||
        (async (ids: string[], now: Date) => {
            await (sharedDb as any)
                .update(jobs as any)
                .set({ lastHeartbeatAt: now })
                .where(inArray((jobs as any).id, ids));
        });
    (async () => {
        while (!stopped && !shuttingDown) {
            try {
                if (activeJobs.size) {
                    const ids = Array.from(activeJobs);
                    const now = new Date();
                    // eslint-disable-next-line no-await-in-loop
                    await updater(ids, now);
                    metrics.inc('worker.heartbeats_total');
                    consecutiveFailures = 0;
                }
            } catch (e) {
                consecutiveFailures++;
                metrics.inc('worker.heartbeat_failures_total');
                if (consecutiveFailures > 3) {
                    log.warn('heartbeat degraded', {
                        error: String(e),
                        consecutiveFailures,
                    });
                    try {
                        opts.onWarn?.(consecutiveFailures, e);
                    } catch {}
                }
            }
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, intervalMs));
        }
    })();
    return () => {
        stopped = true;
    };
}

async function main() {
    await queue.start();
    const stopHeartbeat = startHeartbeatLoop();
    const maxConc = Number(readEnv('WORKER_MAX_CONCURRENCY') || 4);
    const sem = new (__test as any).Semaphore(maxConc);
    const handler = async ({
        jobId,
        correlationId,
    }: {
        jobId: string;
        correlationId?: string;
    }) => {
        await sem.acquire();
        const startedAt = Date.now();
        const cid = correlationId || jobId; // fallback to jobId if none provided
        const maxMs = Number(readEnv('CLIP_MAX_RUNTIME_SEC') || 600) * 1000; // default 10m
        const nowIso = () => new Date().toISOString();
        let cleanup: (() => Promise<void>) | null = null;
        let outputLocal: string | null = null;

        const finish = async (status: 'done' | 'failed', patch: any = {}) => {
            await jobs.update(jobId, { status, ...patch });
            await events.add({
                jobId,
                ts: nowIso(),
                type: status,
                data: { correlationId: cid },
            });
        };

        try {
            const job = await jobs.get(jobId);
            if (!job) {
                log.warn('job not found', { jobId });
                return;
            }
            if (job.status === 'done') return; // idempotent
            if (job.status !== 'processing') {
                await jobs.update(jobId, {
                    status: 'processing',
                    progress: 0,
                    processingStartedAt: nowIso(),
                });
                await events.add({
                    jobId,
                    ts: nowIso(),
                    type: 'processing',
                    data: { correlationId: cid },
                });
                log.info('job processing start', {
                    jobId,
                    correlationId: cid,
                });
            }
            activeJobs.add(jobId);

            // Resolve source (stage: resolve)
            let resolveRes = await withStage(metrics, 'resolve', async () => {
                if (job.sourceType === 'upload') {
                    return await resolveUploadSource({
                        id: job.id,
                        sourceType: 'upload',
                        sourceKey: job.sourceKey!,
                    } as any);
                } else {
                    return await resolveYouTubeSource({
                        id: job.id,
                        sourceType: 'youtube',
                        sourceUrl: job.sourceUrl!,
                    } as any);
                }
            });
            cleanup = resolveRes.cleanup;
            await events.add({
                jobId,
                ts: nowIso(),
                type: 'source:ready',
                data: {
                    durationSec: resolveRes.meta?.durationSec,
                    correlationId: cid,
                },
            });

            // Perform clip
            const clipStart = Date.now();
            const { localPath: clipPath, progress$ } = await withStage(
                metrics,
                'clip',
                async () =>
                    await clipper.clip({
                        input: resolveRes.localPath,
                        startSec: job.startSec,
                        endSec: job.endSec,
                        jobId,
                    })
            );
            outputLocal = clipPath;
            let lastPersist = 0;
            let lastPct = -1;
            const persist = async (pct: number) => {
                await jobs.update(jobId, { progress: pct });
                await events.add({
                    jobId,
                    ts: nowIso(),
                    type: 'progress',
                    data: { pct, stage: 'clip', correlationId: cid },
                });
            };
            const debounceMs = 500;
            for await (const pct of progress$) {
                const now = Date.now();
                // Global timeout enforcement
                if (now - startedAt > maxMs) {
                    throw new Error('CLIP_TIMEOUT');
                }
                if (
                    pct === 100 ||
                    pct >= lastPct + 1 ||
                    now - lastPersist >= debounceMs
                ) {
                    await persist(pct);
                    lastPersist = now;
                    lastPct = pct;
                }
            }
            if (lastPct < 100) await persist(100);

            // Upload result
            if (!storage) throw new Error('STORAGE_NOT_AVAILABLE');
            const key = storageKeys.resultVideo(jobId);
            // Retry transient storage failures (network / 5xx) with exponential backoff
            const uploadWithRetry = async () => {
                const maxAttempts = Number(
                    readEnv('STORAGE_UPLOAD_ATTEMPTS') || 4
                );
                let attempt = 0;
                let delay = 200;
                // simple transient detector
                const isTransient = (err: any) => {
                    const msg = String(err?.message || err);
                    return /timeout|fetch|network|ECONN|EAI_AGAIN|ENOTFOUND|5\d{2}/i.test(
                        msg
                    );
                };
                // eslint-disable-next-line no-constant-condition
                while (true) {
                    try {
                        attempt++;
                        await storage.upload(clipPath, key, 'video/mp4');
                        return;
                    } catch (e) {
                        if (attempt >= maxAttempts || !isTransient(e)) {
                            throw e;
                        }
                        log.warn('storage upload retry', {
                            jobId,
                            attempt,
                            error: String(e),
                        });
                        await new Promise((r) => setTimeout(r, delay));
                        delay = Math.min(delay * 2, 2000);
                    }
                }
            };
            await withStage(metrics, 'upload', async () => {
                await uploadWithRetry();
            });
            metrics.observe('clip.upload_ms', Date.now() - clipStart);
            await events.add({
                jobId,
                ts: nowIso(),
                type: 'uploaded',
                data: { key, correlationId: cid },
            });

            // If subtitles requested and set to auto, create ASR job request (fire-and-forget)
            if (
                job.withSubtitles &&
                (job.subtitleLang === 'auto' || !job.subtitleLang)
            ) {
                await withStage(metrics, 'asr', async () => {
                    try {
                        const asrRes = await asrFacade.request({
                            localPath: clipPath,
                            clipJobId: job.id,
                            sourceType: 'internal',
                            languageHint: job.subtitleLang ?? 'auto',
                        });
                        await events.add({
                            jobId,
                            ts: nowIso(),
                            type: 'asr:requested',
                            data: {
                                asrJobId: asrRes.asrJobId,
                                status: asrRes.status,
                                correlationId: cid,
                            },
                        });
                    } catch (e) {
                        await events.add({
                            jobId,
                            ts: nowIso(),
                            type: 'asr:error',
                            data: { err: String(e), correlationId: cid },
                        });
                        // swallow so primary pipeline continues
                    }
                });
            }

            await finish('done', { progress: 100, resultVideoKey: key });
            metrics.observe('clip.total_ms', Date.now() - startedAt);
            const ms = Date.now() - startedAt;
            log.info('job completed', { jobId, ms, correlationId: cid });
        } catch (e) {
            const err = fromException(e, jobId);
            log.error('job failed', { jobId, err, correlationId: cid });
            metrics.inc('clip.failures');
            try {
                await jobs.update(jobId, {
                    status: 'failed',
                    errorCode:
                        (err.error && (err.error as any).code) || 'INTERNAL',
                    errorMessage:
                        (err.error && (err.error as any).message) || String(e),
                });
                await events.add({
                    jobId,
                    ts: nowIso(),
                    type: 'failed',
                    data: { correlationId: cid },
                });
            } catch {}
        } finally {
            // Final heartbeat on exit (success or failure) if runtime not exceeded
            activeJobs.delete(jobId);
            try {
                await jobs.update(jobId, {
                    lastHeartbeatAt: nowIso(),
                } as any);
            } catch {}
            // Cleanup source + local output
            if (cleanup) {
                try {
                    await cleanup();
                } catch {}
            }
            if (outputLocal) {
                try {
                    await Bun.spawn(['rm', '-f', outputLocal]).exited;
                } catch {}
            }
            sem.release();
        }
    };
    if ((queue as any).adaptiveConsume) {
        log.info('using adaptive queue consumption (capacity-aware prefetch)');
        (queue as any)
            .adaptiveConsume(handler, () => sem.capacity())
            .catch((e: any) =>
                log.error('adaptiveConsume loop crashed', { error: String(e) })
            );
    } else {
        await (queue as any).consume(handler);
    }
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
        shuttingDown = true;
        log.info('worker stopping');
        await queue.shutdown();
        // allow heartbeat loop to exit gracefully
        setTimeout(() => process.exit(0), 500);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    run();
}

// Test hooks (non-production usage)
export const __test = {
    activeJobs,
    startHeartbeatLoop,
    metrics,
    // recovery test hooks will be appended below after definition
};

// ------------------ Recovery Scanner (Req 3) ------------------
async function runRecoveryScan(now = new Date()) {
    const heartbeatIntervalMs = Number(
        readEnv('WORKER_HEARTBEAT_INTERVAL_MS') || 10_000
    );
    const leaseTimeoutSec = Number(
        readEnv('WORKER_LEASE_TIMEOUT_SEC') ||
            Math.ceil((heartbeatIntervalMs / 1000) * 3)
    );
    const maxAttempts = Number(readEnv('JOB_MAX_ATTEMPTS') || 3);
    const staleCutoff = new Date(now.getTime() - leaseTimeoutSec * 1000);
    const start = Date.now();
    let requeued: { id: string }[] = [];
    let exhausted: { id: string }[] = [];
    await (sharedDb as any).transaction(async (tx: any) => {
        // Requeue stale processing jobs under attempt limit
        requeued = await tx
            .update(jobsTable)
            .set({
                status: 'queued',
                attemptCount: sql`${jobsTable.attemptCount} + 1`,
                updatedAt: now,
            })
            .where(
                and(
                    eq(jobsTable.status, 'processing'),
                    lt(jobsTable.lastHeartbeatAt, staleCutoff),
                    lt(jobsTable.attemptCount, maxAttempts)
                )
            )
            .returning({ id: jobsTable.id });
        if (requeued.length) {
            // Emit requeued:stale events
            await tx.insert(jobEvents).values(
                requeued.map((r) => ({
                    jobId: r.id,
                    ts: now,
                    type: 'requeued:stale',
                    data: null,
                }))
            );
        }
        // Mark exhausted attempts as failed
        exhausted = await tx
            .update(jobsTable)
            .set({
                status: 'failed',
                errorCode: 'RETRIES_EXHAUSTED',
                errorMessage: 'Lease expired and retry attempts exhausted',
                updatedAt: now,
            })
            .where(
                and(
                    eq(jobsTable.status, 'processing'),
                    lt(jobsTable.lastHeartbeatAt, staleCutoff),
                    gte(jobsTable.attemptCount, maxAttempts)
                )
            )
            .returning({ id: jobsTable.id });
        if (exhausted.length) {
            await tx.insert(jobEvents).values(
                exhausted.map((r) => ({
                    jobId: r.id,
                    ts: now,
                    type: 'failed',
                    data: { code: 'RETRIES_EXHAUSTED' },
                }))
            );
        }
    });
    if (requeued.length)
        metrics.inc('worker.recovered_jobs_total', requeued.length, {
            reason: 'stale',
        });
    if (exhausted.length)
        metrics.inc('worker.retry_exhausted_total', exhausted.length);
    metrics.observe('worker.recovery_scan_ms', Date.now() - start);
    return {
        requeued: requeued.map((r) => r.id),
        exhausted: exhausted.map((r) => r.id),
    };
}

function startRecoveryScanner() {
    const intervalMsBase = Number(
        readEnv('WORKER_RECOVERY_SCAN_INTERVAL_MS') || 30_000
    );
    let stopped = false;
    (async () => {
        while (!stopped && !shuttingDown) {
            try {
                await runRecoveryScan();
            } catch (e) {
                log.error('recovery scan failed', { error: String(e) });
            }
            const jitter = Math.floor(intervalMsBase * 0.1 * Math.random());
            await new Promise((r) => setTimeout(r, intervalMsBase + jitter));
        }
    })();
    return () => {
        stopped = true;
    };
}

// augment test hooks
(__test as any).runRecoveryScan = runRecoveryScan;
(__test as any).startRecoveryScanner = startRecoveryScanner;

// ------------------ Concurrency Control (Req 4) ------------------
class Semaphore {
    private queue: (() => void)[] = [];
    public inflight = 0;
    constructor(public readonly limit: number) {}
    capacity() {
        return Math.max(0, this.limit - this.inflight);
    }
    async acquire() {
        if (this.inflight < this.limit) {
            this.inflight++;
            metrics.setGauge('worker.concurrent_jobs', this.inflight);
            return;
        }
        await new Promise<void>((res) => this.queue.push(res));
        this.inflight++;
        metrics.setGauge('worker.concurrent_jobs', this.inflight);
    }
    release() {
        this.inflight = Math.max(0, this.inflight - 1);
        metrics.setGauge('worker.concurrent_jobs', this.inflight);
        const next = this.queue.shift();
        if (next) next();
    }
}
(__test as any).Semaphore = Semaphore;
