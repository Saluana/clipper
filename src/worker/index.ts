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
import os from 'os';
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

// ------------------ Backpressure (Req 5) ------------------
interface BackpressureOpts {
    getDepth: () => Promise<number> | number;
    getCpu: () => number;
    highDepth: number;
    highCpu: number;
    pauseMs: number;
    now?: () => number;
}
function createBackpressureController(opts: BackpressureOpts) {
    let pausedUntil = 0;
    const nowFn = opts.now || (() => Date.now());
    async function evaluate(): Promise<boolean> {
        const now = nowFn();
        if (pausedUntil && now < pausedUntil) return false;
        const depth = await opts.getDepth();
        const cpu = opts.getCpu();
        if (depth >= opts.highDepth && cpu >= opts.highCpu) {
            pausedUntil = now + opts.pauseMs;
            metrics.inc('worker.pauses_total');
            log.info('backpressure pause', {
                depth,
                cpuLoad: cpu,
                pauseMs: opts.pauseMs,
            });
            return true;
        }
        return false;
    }
    function isPaused() {
        return pausedUntil > nowFn();
    }
    return {
        evaluate,
        isPaused,
        get pausedUntil() {
            return pausedUntil;
        },
    };
}
export const __backpressureTest = { createBackpressureController };
// ------------------ Progress Throttling Helper (Req 8) ------------------
interface ThrottleOpts {
    persist: (pct: number) => Promise<void>;
    now: () => number;
    debounceMs: number; // time-based emit if exceeded
    enforce?: (now: number) => void; // optional timeout / extra checks
}
async function throttleProgress(
    progressIter: AsyncIterable<number>,
    opts: ThrottleOpts
) {
    let lastEmitTs = 0;
    let lastPct = -1;
    for await (const pct of progressIter) {
        const now = opts.now();
        opts.enforce?.(now);
        if (
            pct === 100 ||
            pct >= lastPct + 1 ||
            now - lastEmitTs >= opts.debounceMs
        ) {
            await opts.persist(pct);
            lastPct = pct;
            lastEmitTs = now;
        }
    }
    if (lastPct < 100) {
        await opts.persist(100);
    }
}
export const __progressTest = { throttleProgress };
// Retry classification helper (Req 7)
type RetryClass = 'retryable' | 'fatal';
function classifyError(e: any): RetryClass {
    const msg = String(e?.message || e || '').toUpperCase();
    if (
        /STORAGE_UPLOAD_FAILED|YTDLP_TIMEOUT|CLIP_TIMEOUT|UPSTREAM|INTERNAL_TRANSIENT|NETWORK|ECONN|EAI_AGAIN/.test(
            msg
        )
    )
        return 'retryable';
    if (/OUTPUT_EMPTY|OUTPUT_MISSING/.test(msg)) return 'retryable';
    return 'fatal';
}
export const __retryTest = { classifyError };
async function handleRetryError(
    jobId: string,
    correlationId: string | undefined,
    e: any
) {
    const nowIso = () => new Date().toISOString();
    const clazz = classifyError(e);
    if (clazz === 'retryable') {
        const maxAttempts = Number(readEnv('JOB_MAX_ATTEMPTS') || 3);
        const updated = await (sharedDb as any)
            .update(jobsTable)
            .set({
                status: sql`CASE WHEN ${jobsTable.attemptCount} + 1 < ${maxAttempts} THEN 'queued' ELSE 'failed' END`,
                attemptCount: sql`${jobsTable.attemptCount} + 1`,
                errorCode: 'RETRYABLE_ERROR',
                errorMessage: String(e),
                updatedAt: new Date(),
            })
            .where(eq(jobsTable.id, jobId))
            .returning({
                attemptCount: jobsTable.attemptCount,
                status: jobsTable.status,
            });
        const attempt = updated[0]?.attemptCount ?? 0;
        metrics.inc('worker.retry_attempts_total', 1, { code: 'retryable' });
        if (attempt >= maxAttempts) {
            await events.add({
                jobId,
                ts: nowIso(),
                type: 'failed',
                data: { correlationId, code: 'RETRIES_EXHAUSTED' },
            });
        } else {
            await events.add({
                jobId,
                ts: nowIso(),
                type: 'requeued:retry',
                data: { attempt, correlationId },
            });
        }
        return clazz;
    } else {
        const err = fromException(e, jobId);
        metrics.inc('clip.failures');
        try {
            await jobs.update(jobId, {
                status: 'failed',
                errorCode: (err.error && (err.error as any).code) || 'FATAL',
                errorMessage:
                    (err.error && (err.error as any).message) || String(e),
            });
            await events.add({
                jobId,
                ts: nowIso(),
                type: 'failed',
                data: { correlationId },
            });
        } catch {}
        return clazz;
    }
}
export const __retryInternal = { handleRetryError };
// expose on global for tests that import worker side-effects
(globalThis as any).__backpressureTest = __backpressureTest;

async function main() {
    await queue.start();
    startHeartbeatLoop();
    const maxConc = Number(readEnv('WORKER_MAX_CONCURRENCY') || 4);
    const sem = new Semaphore(maxConc);
    const highDepth = Number(readEnv('WORKER_QUEUE_HIGH_WATERMARK') || 500);
    const highCpu = Number(readEnv('WORKER_CPU_LOAD_HIGH') || os.cpus().length);
    const pauseMs = Number(readEnv('WORKER_BACKPRESSURE_PAUSE_MS') || 3000);
    const backpressure = createBackpressureController({
        getDepth: async () => {
            try {
                const r = await (sharedDb as any)
                    .select({ c: sql<number>`count(*)` })
                    .from(jobsTable)
                    .where(eq(jobsTable.status, 'queued'));
                return Number(r[0]?.c || 0);
            } catch (e) {
                log.warn('queue depth query failed', { error: String(e) });
                return 0;
            }
        },
        getCpu: () => os.loadavg()[0] || 0,
        highDepth,
        highCpu,
        pauseMs,
    });
    (async () => {
        while (!shuttingDown) {
            try {
                await backpressure.evaluate();
            } catch (e) {
                log.warn('backpressure evaluate failed', { error: String(e) });
            }
            await new Promise((r) => setTimeout(r, 1000));
        }
    })();

    const handler = async (msg: { jobId: string; correlationId?: string }) => {
        const { jobId, correlationId } = msg;
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
            // Atomic acquire: only proceed if currently queued. Prevent duplicate starts (Req 6)
            if (job.status === 'queued') {
                const acquired = await (sharedDb as any)
                    .update(jobsTable)
                    .set({
                        status: 'processing',
                        processingStartedAt: new Date(),
                        lastHeartbeatAt: new Date(),
                        updatedAt: new Date(),
                    })
                    .where(
                        and(
                            eq(jobsTable.id, jobId),
                            eq(jobsTable.status, 'queued')
                        )
                    )
                    .returning({ id: jobsTable.id });
                if (!acquired.length) {
                    metrics.inc('worker.acquire_conflicts_total');
                    log.info('acquire conflict skip', { jobId });
                    return; // another worker got it
                }
                await events.add({
                    jobId,
                    ts: nowIso(),
                    type: 'processing',
                    data: { correlationId: cid },
                });
                log.info('job processing start', { jobId, correlationId: cid });
            } else if (job.status !== 'processing') {
                // Unexpected state, skip (could be failed/cancelled)
                log.info('skip job in non-runnable state', {
                    jobId,
                    status: job.status,
                });
                return;
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
            // Idempotent artifact pre-check
            const finalKey = storageKeys.resultVideo(jobId);
            let finalLocalPath: string | null = null;
            if (storage) {
                try {
                    // Attempt signed URL then head fetch to see if object exists (cheap existence check)
                    const signed = await storage.sign(finalKey, 30);
                    const head = await fetch(signed, { method: 'HEAD' });
                    if (head.ok) {
                        log.info('idempotent skip existing artifact', {
                            jobId,
                            key: finalKey,
                        });
                        await finish('done', {
                            progress: 100,
                            resultVideoKey: finalKey,
                        });
                        metrics.inc('worker.idempotent_skips_total');
                        return; // short circuit entire processing
                    }
                } catch {}
            }
            const tempDir = `/tmp/clipper/${jobId}`;
            try {
                await Bun.spawn(['mkdir', '-p', tempDir]).exited;
            } catch {}
            const tempOut = `${tempDir}/clip.tmp.mp4`;
            const finalOut = `${tempDir}/clip.final.mp4`;
            const { localPath: clipPath, progress$ } = await withStage(
                metrics,
                'clip',
                async () =>
                    await clipper.clip({
                        input: resolveRes.localPath,
                        startSec: job.startSec,
                        endSec: job.endSec,
                        jobId,
                        // override output path if clipper supports? (assumed internal uses jobId)
                    })
            );
            outputLocal = clipPath;
            // Progress throttling (Req 8) via helper
            const persist = async (pct: number) => {
                await jobs.update(jobId, { progress: pct });
                await events.add({
                    jobId,
                    ts: nowIso(),
                    type: 'progress',
                    data: { pct, stage: 'clip', correlationId: cid },
                });
            };
            const enforceTimeout = (now: number) => {
                if (now - startedAt > maxMs) throw new Error('CLIP_TIMEOUT');
            };
            await throttleProgress(progress$, {
                persist,
                now: () => Date.now(),
                debounceMs: 500,
                enforce: enforceTimeout,
            });
            // Integrity validation (size>0) & atomic move into finalOut
            try {
                const f = Bun.file(clipPath);
                if (!(await f.exists())) throw new Error('OUTPUT_MISSING');
                const size = (await f.arrayBuffer()).byteLength;
                if (size <= 0) throw new Error('OUTPUT_EMPTY');
                // atomic move (rename) to final path
                try {
                    await Bun.spawn(['mv', clipPath, finalOut]).exited;
                    outputLocal = finalOut;
                } catch (e) {
                    // fallback copy
                    await Bun.write(finalOut, await f.arrayBuffer());
                    outputLocal = finalOut;
                }
            } catch (e) {
                log.error('output integrity validation failed', {
                    jobId,
                    err: String(e),
                });
                throw e;
            }

            // Upload result
            if (!storage) throw new Error('STORAGE_NOT_AVAILABLE');
            const key = finalKey; // reuse deterministic key
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
                        await storage.upload(outputLocal!, key, 'video/mp4');
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
            const clazz = classifyError(e);
            if (clazz === 'retryable') {
                const maxAttempts = Number(readEnv('JOB_MAX_ATTEMPTS') || 3);
                // Atomic increment + status decision
                const updated = await (sharedDb as any)
                    .update(jobsTable)
                    .set({
                        status: sql`CASE WHEN ${jobsTable.attemptCount} + 1 < ${maxAttempts} THEN 'queued' ELSE 'failed' END`,
                        attemptCount: sql`${jobsTable.attemptCount} + 1`,
                        errorCode: 'RETRYABLE_ERROR',
                        errorMessage: String(e),
                        updatedAt: new Date(),
                    })
                    .where(eq(jobsTable.id, jobId))
                    .returning({ attemptCount: jobsTable.attemptCount });
                const attempt = updated[0]?.attemptCount ?? 0;
                metrics.inc('worker.retry_attempts_total', 1, {
                    code: 'retryable',
                });
                if (attempt >= maxAttempts) {
                    await events.add({
                        jobId,
                        ts: nowIso(),
                        type: 'failed',
                        data: { correlationId: cid, code: 'RETRIES_EXHAUSTED' },
                    });
                    log.error('retry attempts exhausted', { jobId, attempt });
                } else {
                    await events.add({
                        jobId,
                        ts: nowIso(),
                        type: 'requeued:retry',
                        data: { attempt, correlationId: cid },
                    });
                    log.warn('job requeued for retry', { jobId, attempt });
                }
            } else {
                const err = fromException(e, jobId);
                log.error('job failed (fatal)', {
                    jobId,
                    err,
                    correlationId: cid,
                });
                metrics.inc('clip.failures');
                try {
                    await jobs.update(jobId, {
                        status: 'failed',
                        errorCode:
                            (err.error && (err.error as any).code) || 'FATAL',
                        errorMessage:
                            (err.error && (err.error as any).message) ||
                            String(e),
                    });
                    await events.add({
                        jobId,
                        ts: nowIso(),
                        type: 'failed',
                        data: { correlationId: cid },
                    });
                } catch {}
            }
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
            .adaptiveConsume(handler, () =>
                backpressure.isPaused() ? 0 : sem.capacity()
            )
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
