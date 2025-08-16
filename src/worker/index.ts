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
import { startResourceSampler } from '@clipper/common/resource-sampler';
import { withStage } from './stage';
import os from 'os';
import { classifyError as _classifyErrorUtil, getMaxRetries } from './retry';
import {
    cleanupScratch as cleanupScratchNew,
    measureDirSizeBytes as measureDirSizeBytesNew,
    cleanupStorageOnFailure,
} from './cleanup';
export * from './asr.ts';

const log = createLogger((readEnv('LOG_LEVEL') as any) || 'info').with({
    mod: 'worker',
});
const workerId = `${os.hostname?.() || 'host'}-${process.pid}`;
// Default lease extension per heartbeat (sec): prefer JOB_LEASE_SEC, fallback to QUEUE_VISIBILITY_SEC, else 300s
const DEFAULT_LEASE_SEC = (() => {
    const a = Number(readEnv('JOB_LEASE_SEC'));
    if (Number.isFinite(a) && a > 0) return Math.floor(a);
    const b = Number(readEnv('QUEUE_VISIBILITY_SEC'));
    if (Number.isFinite(b) && b > 0) return Math.floor(b);
    return 300;
})();

// Local helper for burning subtitles during inline reuse path
function escapeForSubtitlesFilterLocal(path: string): string {
    return path
        .replace(/\\/g, '\\\\')
        .replace(/:/g, '\\:')
        .replace(/'/g, "\\'")
        .replace(/,/g, '\\,')
        .replace(/ /g, '\\ ');
}
async function burnInSubtitlesLocal(args: {
    srcVideoPath: string;
    srtPath: string;
    outPath: string;
    ffmpegBin?: string;
}): Promise<boolean> {
    const escapedSrt = escapeForSubtitlesFilterLocal(args.srtPath);
    const ffArgs = [
        args.ffmpegBin ?? 'ffmpeg',
        '-y',
        '-i',
        args.srcVideoPath,
        '-vf',
        `subtitles=${escapedSrt}:force_style='FontSize=18,Outline=1,Shadow=0,MarginV=18'`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'copy',
        args.outPath,
    ];
    const proc = Bun.spawn(ffArgs, { stderr: 'pipe' });
    try {
        // Drain stderr to avoid backpressure if ffmpeg is verbose
        if (proc.stderr) {
            for await (const _ of proc.stderr) {
                // no-op
            }
        }
    } catch {}
    const code = await proc.exited;
    return code === 0;
}

const metrics = new InMemoryMetrics();
const sharedDb = createDb();
const jobs = new DrizzleJobsRepo(sharedDb, metrics);
const events = new DrizzleJobEventsRepo(sharedDb, metrics);
const queue = new PgBossQueueAdapter({
    connectionString: requireEnv('DATABASE_URL'),
});
const clipper = new BunClipper();
// Allow tests to inject a storage override
const storage = (() => {
    const override = (globalThis as any).__storageOverride;
    if (override) return override;
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
    queue,
});

const activeJobs = new Set<string>();
let shuttingDown = false;

interface HeartbeatLoopOpts {
    intervalMs?: number;
    updater?: (ids: string[], now: Date) => Promise<void>;
    onWarn?: (failures: number, error: unknown) => void;
}
// Start a lightweight heartbeat loop that batches active job IDs and updates lastHeartbeatAt
function startHeartbeatLoop(opts: HeartbeatLoopOpts = {}) {
    const intervalMs =
        opts.intervalMs ??
        Number(readEnv('WORKER_HEARTBEAT_INTERVAL_MS') || 10_000);
    let stopped = false;
    let consecutiveFailures = 0;
    const updater =
        opts.updater ||
        (async (ids: string[], now: Date) => {
            const nextLease = new Date(
                now.getTime() + DEFAULT_LEASE_SEC * 1000
            );
            await (sharedDb as any)
                .update(jobsTable)
                .set({ lastHeartbeatAt: now, leaseExpiresAt: nextLease })
                .where(inArray(jobsTable.id, ids));
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

// ------------------ Backpressure Controller (Req 5) ------------------
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
(globalThis as any).__backpressureTest = __backpressureTest;

// ------------------ Progress Throttling (Req 9) ------------------
interface ThrottleOpts {
    persist: (pct: number) => Promise<void>;
    now: () => number;
    debounceMs: number;
    enforce?: (now: number) => void;
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

// ------------------ Idempotent Short-circuit Helper (Req 5) ------------------
async function maybeShortCircuitIdempotent(
    jobId: string,
    finalKey: string,
    correlationId: string
): Promise<boolean> {
    const s = (globalThis as any).__storageOverride || storage;
    if (!s) return false;
    try {
        const signed = await s.sign(finalKey, 30);
        const head = await fetch(signed, { method: 'HEAD' });
        if (head.ok) {
            log.info('idempotent skip existing artifact', {
                jobId,
                key: finalKey,
            });
            await events.add({
                jobId,
                ts: new Date().toISOString(),
                type: 'uploaded',
                data: { key: finalKey, correlationId },
            });
            await jobs.update(jobId, {
                status: 'done',
                progress: 100,
                resultVideoKey: finalKey,
            });
            await events.add({
                jobId,
                ts: new Date().toISOString(),
                type: 'done',
                data: { correlationId },
            });
            metrics.inc('worker.idempotent_skips_total');
            return true;
        }
    } catch {}
    return false;
}
// expose for tests
(globalThis as any).__idempotentTest = { maybeShortCircuitIdempotent };

// ------------------ Retry Classification (Req 8) ------------------
type RetryClass = 'retryable' | 'fatal';
function classifyError(e: any): RetryClass {
    return _classifyErrorUtil(e);
}
async function handleRetryError(
    jobId: string,
    correlationId?: string,
    err?: unknown
) {
    const now = new Date();
    const clazz = classifyError(err);
    if (clazz === 'retryable') {
        const maxAttempts = getMaxRetries();
        let attemptCountOut = 0;
        let statusOut = 'queued';
        await (sharedDb as any).transaction(async (tx: any) => {
            const updated = await tx
                .update(jobsTable)
                .set({
                    status: sql`CASE WHEN ${jobsTable.attemptCount} + 1 < ${maxAttempts} THEN 'queued'::job_status ELSE 'failed'::job_status END`,
                    attemptCount: sql`${jobsTable.attemptCount} + 1`,
                    errorCode: sql`CASE WHEN ${jobsTable.attemptCount} + 1 < ${maxAttempts} THEN 'RETRYABLE_ERROR' ELSE 'RETRIES_EXHAUSTED' END`,
                    errorMessage: String(err),
                    updatedAt: now,
                })
                .where(eq(jobsTable.id, jobId))
                .returning({
                    attemptCount: jobsTable.attemptCount,
                    status: jobsTable.status,
                });
            const attemptCount = updated[0]?.attemptCount ?? 0;
            const status = updated[0]?.status ?? 'queued';
            attemptCountOut = attemptCount;
            statusOut = status;
            if (status === 'queued') {
                await tx.insert(jobEvents).values({
                    jobId,
                    ts: now,
                    type: 'requeued:retry',
                    data: { attempt: attemptCount, correlationId },
                });
            } else {
                await tx.insert(jobEvents).values({
                    jobId,
                    ts: now,
                    type: 'failed',
                    data: { correlationId, code: 'RETRIES_EXHAUSTED' },
                });
            }
        });
        metrics.inc('worker.retry_attempts_total', 1, { code: 'retryable' });
        return attemptCountOut;
    }
    // fatal
    try {
        const errObj = fromException(err, jobId);
        await (sharedDb as any).transaction(async (tx: any) => {
            await tx
                .update(jobsTable)
                .set({
                    status: sql`'failed'::job_status`,
                    errorCode:
                        (errObj.error && (errObj.error as any).code) || 'FATAL',
                    errorMessage:
                        (errObj.error && (errObj.error as any).message) ||
                        String(err),
                    updatedAt: now,
                })
                .where(eq(jobsTable.id, jobId));
            await tx.insert(jobEvents).values({
                jobId,
                ts: now,
                type: 'failed',
                data: { correlationId },
            });
        });
    } finally {
        metrics.inc('clip.failures');
    }
    return 0;
}
export const __retryInternal = { classifyError, handleRetryError };
// expose for bun tests
(globalThis as any).__retryInternal = __retryInternal;
(globalThis as any).__retryTest = { classifyError };

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

// Global reference for graceful shutdown wait logic
let semGlobal: { inflight: number } | null = null;

// ------------------ Scratch lifecycle helpers (Req 10) ------------------
const measureDirSizeBytes = measureDirSizeBytesNew;
const cleanupScratch = cleanupScratchNew;
(globalThis as any).__scratchTest = { measureDirSizeBytes, cleanupScratch };

// Remove partial storage objects and scratch on failure, respecting KEEP_FAILED
async function cleanupOnFailure(opts: {
    scratchDir?: string | null;
    storage?: { remove: (key: string) => Promise<void> } | null;
    storageKey?: string | null;
}) {
    await cleanupStorageOnFailure(opts.storage as any, opts.storageKey || null);
    if (opts.scratchDir) {
        await cleanupScratch(opts.scratchDir, false);
    }
}
(globalThis as any).__cleanupTest = { cleanupOnFailure };
async function main() {
    await queue.start();
    startHeartbeatLoop();
    const maxConc = Number(readEnv('WORKER_MAX_CONCURRENCY') || 4);
    const sem = new Semaphore(maxConc);
    semGlobal = sem;
    (globalThis as any).__workerSem = sem;
    const highDepth = Number(readEnv('WORKER_QUEUE_HIGH_WATERMARK') || 500);
    const highCpu = Number(readEnv('WORKER_CPU_LOAD_HIGH') || os.cpus().length);
    const pauseMs = Number(readEnv('WORKER_BACKPRESSURE_PAUSE_MS') || 3000);
    const backpressure = createBackpressureController({
        getDepth: async () => {
            try {
                const r = await (sharedDb as any)
                    .select({ c: sql<number>`count(*)` })
                    .from(jobsTable)
                    .where(
                        and(
                            eq(jobsTable.status, 'queued'),
                            sql`${jobsTable.nextEarliestRunAt} IS NULL OR ${jobsTable.nextEarliestRunAt} <= NOW()`
                        )
                    );
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
        const cid = correlationId || jobId;
        const maxMs = Number(readEnv('CLIP_MAX_RUNTIME_SEC') || 600) * 1000;
        const nowIso = () => new Date().toISOString();
        let cleanup: (() => Promise<void>) | null = null;
        let outputLocal: string | null = null;
        let scratchDir: string | null = null;
        let success = false;

        const finish = async (status: 'done' | 'failed', patch: any = {}) => {
            await jobs.update(jobId, {
                status,
                leaseExpiresAt: null,
                lockedBy: null,
                ...patch,
            });
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
            if (job.status === 'done') return;
            // Duplicate suppression: if already processing and lease is fresh, skip (Req 6)
            if (job.status === 'processing') {
                const hbMs = Number(
                    readEnv('WORKER_HEARTBEAT_INTERVAL_MS') || 10_000
                );
                const leaseSec = Number(
                    readEnv('WORKER_LEASE_TIMEOUT_SEC') ||
                        Math.ceil((hbMs / 1000) * 3)
                );
                const last = job.lastHeartbeatAt
                    ? new Date(job.lastHeartbeatAt as any)
                    : null;
                const fresh = last
                    ? Date.now() - last.getTime() < leaseSec * 1000
                    : false;
                if (fresh) {
                    metrics.inc('worker.duplicate_skips_total');
                    log.info('duplicate skip (fresh lease)', { jobId });
                    return;
                }
            }
            if (job.status === 'queued') {
                const acquired = await (sharedDb as any)
                    .update(jobsTable)
                    .set({
                        status: sql`'processing'::job_status`,
                        processingStartedAt: new Date(),
                        lastHeartbeatAt: new Date(),
                        leaseExpiresAt: new Date(
                            Date.now() + DEFAULT_LEASE_SEC * 1000
                        ),
                        attemptCount: sql`${jobsTable.attemptCount} + 1`,
                        lockedBy: workerId,
                        updatedAt: new Date(),
                    })
                    .where(
                        and(
                            eq(jobsTable.id, jobId),
                            eq(jobsTable.status, 'queued'),
                            sql`${jobsTable.nextEarliestRunAt} IS NULL OR ${jobsTable.nextEarliestRunAt} <= NOW()`
                        )
                    )
                    .returning({ id: jobsTable.id });
                if (!acquired.length) {
                    metrics.inc('worker.acquire_conflicts_total');
                    metrics.inc('worker.atomic_acquire_fail_total');
                    log.info('acquire conflict skip', { jobId });
                    return;
                }
                await events.add({
                    jobId,
                    ts: nowIso(),
                    type: 'processing',
                    data: { correlationId: cid },
                });
                log.info('job processing start', { jobId, correlationId: cid });
            } else if (job.status !== 'processing') {
                log.info('skip job in non-runnable state', {
                    jobId,
                    status: job.status,
                });
                return;
            }
            activeJobs.add(jobId);
            try {
                metrics.setGauge('worker.inflight_jobs', activeJobs.size);
            } catch {}

            const resolveRes = await withStage(metrics, 'resolve', async () => {
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

            const clipStart = Date.now();
            const finalKey = storageKeys.resultVideo(jobId);
            // Idempotent short-circuit
            if (await maybeShortCircuitIdempotent(jobId, finalKey, cid)) return;
            const tempDir = `/tmp/clipper/${jobId}`;
            scratchDir = tempDir;
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
                    })
            );
            outputLocal = clipPath;
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

            try {
                const f = Bun.file(clipPath);
                if (!(await f.exists())) throw new Error('OUTPUT_MISSING');
                const size = (await f.arrayBuffer()).byteLength;
                if (size <= 0) throw new Error('OUTPUT_EMPTY');
                try {
                    await Bun.spawn(['mv', clipPath, finalOut]).exited;
                    outputLocal = finalOut;
                } catch {
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

            if (!storage) throw new Error('STORAGE_NOT_AVAILABLE');
            const key = finalKey;
            const uploadWithRetry = async () => {
                const maxAttempts = Number(
                    readEnv('STORAGE_UPLOAD_ATTEMPTS') || 4
                );
                let attempt = 0;
                let delay = 200;
                const isTransient = (err: any) =>
                    /timeout|fetch|network|ECONN|EAI_AGAIN|ENOTFOUND|5\d{2}/i.test(
                        String(err?.message || err)
                    );
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

            // Persist the resultVideoKey before we enqueue ASR.
            // This avoids a race where the ASR worker fetches the clip job and
            // doesn't see the key yet, causing a NO_CLIP_RESULT error.
            try {
                await jobs.update(jobId, { resultVideoKey: key } as any);
            } catch (e) {
                log.warn('failed to persist resultVideoKey pre-ASR', {
                    jobId,
                    err: String(e),
                });
            }

            let asrRequested = false;
            let asrStatus: 'queued' | 'reused' | null = null;
            let asrArtifacts: Array<{ kind: string; storageKey: string }> = [];
            if (job.withSubtitles) {
                await withStage(metrics, 'asr', async () => {
                    try {
                        const asrRes = await asrFacade.request({
                            // Use the current on-disk output path after move/copy,
                            // not the original clipPath which may have been moved.
                            localPath: outputLocal || finalOut,
                            clipJobId: job.id,
                            sourceType: 'internal',
                            languageHint: job.subtitleLang || 'auto',
                        });
                        asrRequested = true;
                        asrStatus = asrRes.status;
                        if (
                            asrRes.status === 'reused' &&
                            Array.isArray(asrRes.artifacts)
                        ) {
                            asrArtifacts = asrRes.artifacts.map((a: any) => ({
                                kind: a.kind,
                                storageKey: a.storageKey,
                            }));
                        }
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
                    }
                });
            }

            // Fast-path: if ASR returned a reused artifact set, attach SRT and optionally burn-in here
            if (asrStatus === 'reused') {
                try {
                    const srtKey = asrArtifacts.find(
                        (a) => a.kind === 'srt'
                    )?.storageKey;
                    if (srtKey) {
                        try {
                            await jobs.update(jobId, {
                                resultSrtKey: srtKey,
                            } as any);
                        } catch {}
                    }
                    if (job.burnSubtitles && srtKey && storage && key) {
                        // Emit started event
                        try {
                            await events.add({
                                jobId,
                                ts: nowIso(),
                                type: 'burnin:started',
                                data: { srtKey, in: key },
                            });
                        } catch {}
                        const burnedKey = storageKeys.resultVideoBurned(jobId);
                        const localIn = await storage.download(key);
                        const localSrt = await storage.download(srtKey);
                        const outLocal = `/tmp/${jobId}.subbed.mp4`;
                        const ok = await burnInSubtitlesLocal({
                            srcVideoPath: localIn,
                            srtPath: localSrt,
                            outPath: outLocal,
                        });
                        if (ok) {
                            await storage.upload(
                                outLocal,
                                burnedKey,
                                'video/mp4'
                            );
                            try {
                                await jobs.update(jobId, {
                                    resultVideoBurnedKey: burnedKey,
                                } as any);
                            } catch {}
                            try {
                                await events.add({
                                    jobId,
                                    ts: nowIso(),
                                    type: 'burnin:completed',
                                    data: { key: burnedKey },
                                });
                            } catch {}
                        } else {
                            try {
                                await events.add({
                                    jobId,
                                    ts: nowIso(),
                                    type: 'burnin:failed',
                                    data: { srtKey, in: key },
                                });
                            } catch {}
                        }
                    }
                } catch (e) {
                    // Non-fatal, proceed to finalize with whatever we have
                }
                // We handled reuse inline; don't wait on ASR worker to finalize
                asrRequested = false;
            }

            // If burn-in was requested, let the ASR worker finalize the job
            // status to 'done' after producing subtitles/burned video. This
            // prevents returning an unburned result when the user asked for
            // burnSubtitles=true.
            if (job.burnSubtitles && asrRequested) {
                log.info('awaiting burn-in; leaving job processing', {
                    jobId,
                    correlationId: cid,
                });
            } else {
                await finish('done', { progress: 100, resultVideoKey: key });
            }
            metrics.observe('clip.total_ms', Date.now() - startedAt);
            const ms = Date.now() - startedAt;
            log.info('job completed', { jobId, ms, correlationId: cid });
            success = true;
        } catch (e) {
            const clazz = classifyError(e);
            if (clazz === 'retryable') {
                // Best-effort remove partial object on retryable failure, unless KEEP_FAILED
                try {
                    await cleanupStorageOnFailure(
                        storage as any,
                        storageKeys.resultVideo(jobId)
                    );
                } catch {}
                const maxAttempts = getMaxRetries();
                const updated = await (sharedDb as any)
                    .update(jobsTable)
                    .set({
                        status: sql`CASE WHEN ${jobsTable.attemptCount} + 1 < ${maxAttempts} THEN 'queued'::job_status ELSE 'failed'::job_status END`,
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
                // Best-effort cleanup of partial storage and scratch if not keeping failed
                try {
                    await cleanupOnFailure({
                        scratchDir,
                        storage,
                        storageKey: storageKeys.resultVideo(jobId),
                    });
                } catch {}
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
            activeJobs.delete(jobId);
            try {
                metrics.setGauge('worker.inflight_jobs', activeJobs.size);
            } catch {}
            try {
                await jobs.update(jobId, { lastHeartbeatAt: nowIso() } as any);
            } catch {}
            if (cleanup) {
                try {
                    await cleanup();
                } catch {}
            }
            if (scratchDir) {
                try {
                    await cleanupScratch(scratchDir, success);
                } catch {}
            }
            sem.release();
        }
    };

    if ((queue as any).adaptiveConsume) {
        log.info('using adaptive queue consumption (capacity-aware prefetch)');
        (queue as any)
            .adaptiveConsume(handler, () =>
                shuttingDown || backpressure.isPaused() ? 0 : sem.capacity()
            )
            .catch((e: any) =>
                log.error('adaptiveConsume loop crashed', { error: String(e) })
            );
    } else {
        await (queue as any).consume(handler);
    }
}

// Wait for active jobs to finish with a timeout and emit aborted events if needed
async function waitForActiveJobsToFinish(
    timeoutMs: number
): Promise<{ timedOut: boolean; aborted: string[] }> {
    const start = Date.now();
    const pollMs = 100;
    const getInflight = () =>
        semGlobal?.inflight ?? (globalThis as any).__workerSem?.inflight ?? 0;
    while (getInflight() > 0 && Date.now() - start < timeoutMs) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, pollMs));
    }
    if (getInflight() === 0) return { timedOut: false, aborted: [] };
    const aborted = Array.from(activeJobs);
    for (const id of aborted) {
        try {
            await events.add({
                jobId: id,
                ts: new Date().toISOString(),
                type: 'aborted:shutdown',
                data: {},
            });
        } catch {}
    }
    return { timedOut: true, aborted };
}

if (import.meta.main) {
    const run = async () => {
        try {
            // Start resource sampler in worker too
            startResourceSampler(metrics, { intervalMs: 15000 });
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
        const timeoutMs = Number(
            readEnv('WORKER_SHUTDOWN_TIMEOUT_MS') || 15000
        );
        const { timedOut, aborted } = await waitForActiveJobsToFinish(
            timeoutMs
        );
        if (timedOut && aborted.length) {
            log.warn('shutdown timeout; jobs aborted', {
                count: aborted.length,
                aborted,
            });
        }
        process.exit(0);
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
    // graceful shutdown test hooks
    _internal: {
        get inflight() {
            return (globalThis as any).__workerSem?.inflight ?? 0;
        },
        setInflight(n: number) {
            (globalThis as any).__workerSem = { inflight: n };
            semGlobal = (globalThis as any).__workerSem;
        },
        waitForActiveJobsToFinish,
    },
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
    const maxAttempts = getMaxRetries();
    const staleCutoff = new Date(now.getTime() - leaseTimeoutSec * 1000);
    const start = Date.now();
    let requeued: { id: string }[] = [];
    let exhausted: { id: string }[] = [];
    await (sharedDb as any).transaction(async (tx: any) => {
        // Requeue stale processing jobs under attempt limit
        requeued = await tx
            .update(jobsTable)
            .set({
                status: sql`'queued'::job_status`,
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
                status: sql`'failed'::job_status`,
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

(__test as any).Semaphore = Semaphore;
