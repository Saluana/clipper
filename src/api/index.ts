import { Elysia } from 'elysia';
import cors from '@elysiajs/cors';
import { Schemas, type CreateJobInputType } from '@clipper/contracts';
import {
    createLogger,
    readEnv,
    readIntEnv,
    requireEnv,
    fromException,
} from '@clipper/common';
import {
    DrizzleJobsRepo,
    DrizzleJobEventsRepo,
    createDb,
    createSupabaseStorageRepo,
} from '@clipper/data';
import { InMemoryMetrics } from '@clipper/common/metrics';
import { PgBossQueueAdapter } from '@clipper/queue';

const metrics = new InMemoryMetrics();
const log = createLogger((readEnv('LOG_LEVEL') as any) || 'info').with({
    mod: 'api',
});

function buildDeps() {
    let queue: any;
    try {
        const cs = requireEnv('DATABASE_URL');
        queue = new PgBossQueueAdapter({ connectionString: cs });
        queue.start?.();
    } catch {
        queue = {
            publish: async () => {},
            publishTo: async () => {},
            health: async () => ({ ok: true }),
            getMetrics: () => ({}),
        };
    }
    const db = createDb();
    const jobsRepo = new DrizzleJobsRepo(db);
    const eventsRepo = new DrizzleJobEventsRepo(db);
    const storage = (() => {
        try {
            return createSupabaseStorageRepo();
        } catch (e) {
            log.warn('storage init failed (signing disabled)', {
                error: String(e),
            });
            return null as any;
        }
    })();
    return { queue, jobsRepo, eventsRepo, storage };
}
const { queue, jobsRepo, eventsRepo, storage } = buildDeps();

function tcToSec(tc: string) {
    const [hh, mm, rest] = tc.split(':');
    const [ss, ms] = rest?.split('.') || [rest || '0', undefined];
    return (
        Number(hh) * 3600 +
        Number(mm) * 60 +
        Number(ss) +
        (ms ? Number(`0.${ms}`) : 0)
    );
}

// Simple correlation id + uniform error envelope middleware
interface ApiErrorEnvelope {
    error: { code: string; message: string; correlationId: string };
}
function buildError(
    set: any,
    code: number,
    errCode: string,
    message: string,
    correlationId: string
): ApiErrorEnvelope {
    set.status = code;
    return { error: { code: errCode, message, correlationId } };
}

export const app = new Elysia()
    .use(cors())
    .onRequest(({ request, store }) => {
        const cid = request.headers.get('x-request-id') || crypto.randomUUID();
        (store as any).correlationId = cid;
    })
    .state('correlationId', '')
    .get('/healthz', async ({ store }) => {
        const h = await queue.health();
        return {
            ok: h.ok,
            queue: h,
            correlationId: (store as any).correlationId,
        };
    })
    .get('/metrics/queue', ({ store }) => ({
        metrics: queue.getMetrics(),
        correlationId: (store as any).correlationId,
    }))
    .get('/metrics', () => {
        const snap = metrics.snapshot();
        return snap;
    })
    .post('/api/jobs', async ({ body, set, store }) => {
        const correlationId = (store as any).correlationId;
        try {
            const parsed = Schemas.CreateJobInput.safeParse(body);
            if (!parsed.success) {
                return buildError(
                    set,
                    400,
                    'VALIDATION_FAILED',
                    parsed.error.message,
                    correlationId
                );
            }
            const input = parsed.data as CreateJobInputType;
            const id = crypto.randomUUID();
            const startSec = tcToSec(input.start);
            const endSec = tcToSec(input.end);
            if (
                endSec - startSec >
                Number(readIntEnv('MAX_CLIP_SECONDS', 120))
            ) {
                return buildError(
                    set,
                    400,
                    'CLIP_TOO_LONG',
                    'Clip exceeds MAX_CLIP_SECONDS',
                    correlationId
                );
            }
            const retentionHours = Number(readIntEnv('RETENTION_HOURS', 72));
            const expiresAt = new Date(Date.now() + retentionHours * 3600_000);
            const row = await jobsRepo.create({
                id,
                status: 'queued',
                progress: 0,
                sourceType: input.sourceType,
                sourceKey: input.uploadKey,
                sourceUrl: input.youtubeUrl,
                startSec,
                endSec,
                withSubtitles: input.withSubtitles,
                burnSubtitles: input.burnSubtitles,
                subtitleLang: input.subtitleLang,
                resultVideoKey: undefined,
                resultSrtKey: undefined,
                errorCode: undefined,
                errorMessage: undefined,
                expiresAt: expiresAt.toISOString(),
            });
            await eventsRepo.add({
                jobId: id,
                ts: new Date().toISOString(),
                type: 'created',
            });
            const publishedAt = Date.now();
            await queue.publish({ jobId: id, priority: 'normal' });
            metrics.inc('jobs.created');
            metrics.observe(
                'jobs.enqueue_latency_ms',
                Date.now() - publishedAt
            );
            log.info('job enqueued', { jobId: id, correlationId });
            return {
                correlationId,
                job: {
                    id: row.id,
                    status: row.status,
                    progress: row.progress,
                    expiresAt: expiresAt.toISOString(),
                },
            };
        } catch (e) {
            const err = fromException(e, correlationId);
            return buildError(
                set,
                500,
                err.error.code,
                err.error.message,
                correlationId
            );
        }
    })
    .get('/api/jobs/:id', async ({ params, set, store }) => {
        const correlationId = (store as any).correlationId;
        const { id } = params as any;
        try {
            const job = await jobsRepo.get(id);
            if (!job) {
                return buildError(
                    set,
                    404,
                    'NOT_FOUND',
                    'Job not found',
                    correlationId
                );
            }
            if (job.expiresAt && new Date(job.expiresAt) < new Date()) {
                return buildError(
                    set,
                    410,
                    'GONE',
                    'Job expired',
                    correlationId
                );
            }
            // recent events (last 10)
            const ev =
                (await (eventsRepo as any).listRecent?.(job.id, 10)) ||
                (await (eventsRepo as any).list(job.id, 10, 0));
            metrics.inc('jobs.status_fetch');
            return {
                correlationId,
                job: {
                    id: job.id,
                    status: job.status,
                    progress: job.progress,
                    resultVideoKey: job.resultVideoKey ?? undefined,
                    resultSrtKey: job.resultSrtKey ?? undefined,
                    expiresAt: job.expiresAt ?? undefined,
                },
                events: ev.map((e: any) => ({
                    ts: e.ts,
                    type: e.type,
                    data: e.data,
                })),
            };
        } catch (e) {
            const err = fromException(e, correlationId);
            return buildError(
                set,
                500,
                err.error.code,
                err.error.message,
                correlationId
            );
        }
    })
    .get('/api/jobs/:id/result', async ({ params, set, store }) => {
        const correlationId = (store as any).correlationId;
        const { id } = params as any;
        try {
            const job = await jobsRepo.get(id);
            if (!job) {
                return buildError(
                    set,
                    404,
                    'NOT_FOUND',
                    'Job not found',
                    correlationId
                );
            }
            if (job.expiresAt && new Date(job.expiresAt) < new Date()) {
                return buildError(
                    set,
                    410,
                    'GONE',
                    'Job expired',
                    correlationId
                );
            }
            if (!job.resultVideoKey || job.status !== 'done') {
                return buildError(
                    set,
                    404,
                    'NOT_READY',
                    'Result not available yet',
                    correlationId
                );
            }
            if (!storage) {
                return buildError(
                    set,
                    500,
                    'STORAGE_UNAVAILABLE',
                    'Storage not configured',
                    correlationId
                );
            }
            const videoUrl = await storage.sign(job.resultVideoKey);
            let srtUrl: string | undefined;
            if (job.resultSrtKey) {
                try {
                    srtUrl = await storage.sign(job.resultSrtKey);
                } catch {}
            }
            metrics.inc('jobs.result_fetch');
            return {
                correlationId,
                result: {
                    id: job.id,
                    video: { key: job.resultVideoKey, url: videoUrl },
                    srt:
                        job.resultSrtKey && srtUrl
                            ? { key: job.resultSrtKey, url: srtUrl }
                            : undefined,
                },
            };
        } catch (e) {
            const err = fromException(e, correlationId);
            return buildError(
                set,
                500,
                err.error.code,
                err.error.message,
                correlationId
            );
        }
    });

if (import.meta.main) {
    const port = Number(readIntEnv('PORT', 3000));
    const server = Bun.serve({ fetch: app.fetch, port });
    log.info('API started', { port });
    const stop = async () => {
        log.info('API stopping');
        server.stop(true);
        await queue.shutdown();
        process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}
