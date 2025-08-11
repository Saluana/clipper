import {
    createLogger,
    readEnv,
    requireEnv,
    fromException,
} from '@clipper/common';
import {
    DrizzleJobsRepo,
    DrizzleJobEventsRepo,
    createDb,
    resolveUploadSource,
    resolveYouTubeSource,
    createSupabaseStorageRepo,
    storageKeys,
} from '@clipper/data';
import { PgBossQueueAdapter } from '@clipper/queue';
import { BunClipper } from '@clipper/ffmpeg';

const log = createLogger((readEnv('LOG_LEVEL') as any) || 'info').with({
    mod: 'worker',
});

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

async function main() {
    await queue.start();
    await queue.consume(async ({ jobId }: { jobId: string }) => {
        const startedAt = Date.now();
        const nowIso = () => new Date().toISOString();
        let cleanup: (() => Promise<void>) | null = null;
        let outputLocal: string | null = null;

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
            };
            const debounceMs = 500;
            for await (const pct of progress$) {
                const now = Date.now();
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
            await storage.upload(clipPath, key, 'video/mp4');
            await events.add({
                jobId,
                ts: nowIso(),
                type: 'uploaded',
                data: { key },
            });

            await finish('done', { progress: 100, resultVideoKey: key });
            const ms = Date.now() - startedAt;
            log.info('job completed', { jobId, ms });
        } catch (e) {
            const err = fromException(e, jobId);
            log.error('job failed', { jobId, err });
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
