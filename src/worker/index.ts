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
import { AsrFacade } from '@clipper/asr/facade';
import { InMemoryMetrics } from '@clipper/common/metrics';
export * from './asr.ts';

const log = createLogger((readEnv('LOG_LEVEL') as any) || 'info').with({
    mod: 'worker',
});

const metrics = new InMemoryMetrics();
const jobs = new DrizzleJobsRepo(createDb());
const events = new DrizzleJobEventsRepo(createDb());
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
    asrJobs: new DrizzleAsrJobsRepo(createDb()),
});

async function main() {
    await queue.start();
    await queue.consume(async ({ jobId }: { jobId: string }) => {
        const startedAt = Date.now();
        const maxMs = Number(readEnv('CLIP_MAX_RUNTIME_SEC') || 600) * 1000; // default 10m
        const nowIso = () => new Date().toISOString();
        let cleanup: (() => Promise<void>) | null = null;
        let outputLocal: string | null = null;
        let lastHeartbeat = 0;
        const heartbeatIntervalMs = Number(
            readEnv('WORKER_HEARTBEAT_INTERVAL_MS') || 15_000
        );
        const sendHeartbeat = async () => {
            const now = Date.now();
            if (now - lastHeartbeat < heartbeatIntervalMs) return;
            lastHeartbeat = now;
            try {
                await jobs.update(jobId, { lastHeartbeatAt: nowIso() } as any);
            } catch {}
        };

        const finish = async (status: 'done' | 'failed', patch: any = {}) => {
            await jobs.update(jobId, { status, ...patch });
            await events.add({ jobId, ts: nowIso(), type: status });
        };

        try {
            const job = await jobs.get(jobId);
            if (!job) {
                log.warn('job not found', { jobId });
                return;
            }
            if (job.status === 'done') return; // idempotent
            if (job.status !== 'processing') {
                await jobs.update(jobId, { status: 'processing', progress: 0 });
                await events.add({ jobId, ts: nowIso(), type: 'processing' });
                log.info('job processing start', { jobId });
            }

            // Resolve source
            let resolveRes: {
                localPath: string;
                cleanup: () => Promise<void>;
                meta?: any;
            };
            if (job.sourceType === 'upload') {
                resolveRes = await resolveUploadSource({
                    id: job.id,
                    sourceType: 'upload',
                    sourceKey: job.sourceKey!,
                } as any);
            } else {
                try {
                    resolveRes = await resolveYouTubeSource({
                        id: job.id,
                        sourceType: 'youtube',
                        sourceUrl: job.sourceUrl!,
                    } as any);
                } catch (e) {
                    throw new Error('RESOLVE_FAILED');
                }
            }
            cleanup = resolveRes.cleanup;
            await events.add({
                jobId,
                ts: nowIso(),
                type: 'source:ready',
                data: { durationSec: resolveRes.meta?.durationSec },
            });

            // Perform clip
            const clipStart = Date.now();
            const { localPath: clipPath, progress$ } = await clipper.clip({
                input: resolveRes.localPath,
                startSec: job.startSec,
                endSec: job.endSec,
                jobId,
            });
            outputLocal = clipPath;
            let lastPersist = 0;
            let lastPct = -1;
            const persist = async (pct: number) => {
                await jobs.update(jobId, { progress: pct });
                await events.add({
                    jobId,
                    ts: nowIso(),
                    type: 'progress',
                    data: { pct, stage: 'clip' },
                });
                await sendHeartbeat();
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
                } else {
                    // Even if we didn't persist progress, still emit heartbeat occasionally
                    await sendHeartbeat();
                }
            }
            if (lastPct < 100) await persist(100);
            await sendHeartbeat();

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
            await uploadWithRetry();
            metrics.observe('clip.upload_ms', Date.now() - clipStart);
            await events.add({
                jobId,
                ts: nowIso(),
                type: 'uploaded',
                data: { key },
            });

            // If subtitles requested and set to auto, create ASR job request (fire-and-forget)
            if (
                job.withSubtitles &&
                (job.subtitleLang === 'auto' || !job.subtitleLang)
            ) {
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
                        },
                    });
                } catch (e) {
                    // don't fail the clip if ASR enqueue fails
                    await events.add({
                        jobId,
                        ts: nowIso(),
                        type: 'asr:error',
                        data: { err: String(e) },
                    });
                }
            }

            await finish('done', { progress: 100, resultVideoKey: key });
            metrics.observe('clip.total_ms', Date.now() - startedAt);
            const ms = Date.now() - startedAt;
            log.info('job completed', { jobId, ms });
        } catch (e) {
            const err = fromException(e, jobId);
            log.error('job failed', { jobId, err });
            metrics.inc('clip.failures');
            try {
                await jobs.update(jobId, {
                    status: 'failed',
                    errorCode:
                        (err.error && (err.error as any).code) || 'INTERNAL',
                    errorMessage:
                        (err.error && (err.error as any).message) || String(e),
                });
                await events.add({ jobId, ts: nowIso(), type: 'failed' });
            } catch {}
        } finally {
            // Final heartbeat on exit (success or failure) if runtime not exceeded
            try {
                await jobs.update(jobId, { lastHeartbeatAt: nowIso() } as any);
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
        }
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
