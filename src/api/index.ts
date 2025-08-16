import { Elysia } from 'elysia';
// Some test environments may not set internal Elysia globals; ensure placeholder
// to prevent TypeError when constructing Elysia during Vitest runs.
// @ts-ignore
if (typeof (globalThis as any).ELYSIA_AOT === 'undefined') {
    // @ts-ignore
    (globalThis as any).ELYSIA_AOT = false;
}
import cors from '@elysiajs/cors';
import { Schemas, type CreateJobInputType } from '@clipper/contracts';
import {
    createLogger,
    readEnv,
    readIntEnv,
    readFloatEnv,
    readBoolEnv,
    requireEnv,
    fromException,
} from '@clipper/common';
import { validateRange, coerceNearZeroDuration } from '@clipper/common/time';
import {
    DrizzleJobsRepo,
    DrizzleJobEventsRepo,
    DrizzleApiKeysRepo,
    createDb,
    createSupabaseStorageRepo,
} from '@clipper/data';
import { InMemoryMetrics, normalizeRoute } from '@clipper/common/metrics';
import { startResourceSampler } from '@clipper/common/resource-sampler';
import { PgBossQueueAdapter } from '@clipper/queue';

export const metrics = new InMemoryMetrics();
const log = createLogger((readEnv('LOG_LEVEL') as any) || 'info').with({
    mod: 'api',
});

// Simple in-memory API key cache & rate limiter (sufficient for single-instance / test)
type ApiKeyCacheEntry = { record: any; expiresAt: number };
const apiKeyCache = new Map<string, ApiKeyCacheEntry>();
const API_KEY_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

interface RateBucket {
    count: number;
    windowStart: number;
}
const rateBuckets = new Map<string, RateBucket>();
function rateLimitHit(key: string, max: number, windowMs: number) {
    const now = Date.now();
    const b = rateBuckets.get(key);
    if (!b || now - b.windowStart >= windowMs) {
        rateBuckets.set(key, { count: 1, windowStart: now });
        return false; // first hit
    }
    if (b.count >= max) return true;
    b.count++;
    return false;
}

function buildDeps() {
    const db = createDb();
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
    const jobsRepo = new DrizzleJobsRepo(db, metrics);
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
    const apiKeys = new DrizzleApiKeysRepo(db);
    return { queue, jobsRepo, eventsRepo, storage, apiKeys };
}
const { queue, jobsRepo, eventsRepo, storage, apiKeys } = buildDeps();

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

const ENABLE_API_KEYS =
    (readEnv('ENABLE_API_KEYS') || 'false').toLowerCase() === 'true';
const RATE_WINDOW_SEC = Number(readEnv('RATE_LIMIT_WINDOW_SEC') || '60');
const RATE_MAX = Number(readEnv('RATE_LIMIT_MAX') || '30');

// HTTP instrumentation middleware (Req 2)
function addHttpInstrumentation(app: Elysia) {
    app.onBeforeHandle(({ store, request, path }) => {
        (store as any)._httpStart = performance.now();
        (store as any)._httpRoute = normalizeRoute(path || '/');
    });
    app.onAfterHandle(({ store, request, set, response }) => {
        try {
            const route =
                (store as any)._httpRoute || normalizeRoute(request.url);
            const started = (store as any)._httpStart || performance.now();
            const dur = performance.now() - started;
            const method = request.method.toUpperCase();
            const codeNum = Number(
                set.status || (response as any)?.status || 200
            );
            const codeClass = `${Math.floor(codeNum / 100)}xx`;
            metrics.inc('http.requests_total', 1, {
                method,
                route,
                code_class: codeClass,
            });
            metrics.observe('http.request_latency_ms', dur, { route });
            if (codeNum >= 400)
                metrics.inc('http.errors_total', 1, { route, code: codeNum });
        } catch {}
    });
    app.onError(({ store, request, set }) => {
        try {
            const route =
                (store as any)._httpRoute || normalizeRoute(request.url);
            const method = request.method.toUpperCase();
            const codeNum = Number(set.status || 500);
            const codeClass = `${Math.floor(codeNum / 100)}xx`;
            metrics.inc('http.requests_total', 1, {
                method,
                route,
                code_class: codeClass,
            });
            metrics.inc('http.errors_total', 1, { route, code: codeNum });
        } catch {}
    });
    return app;
}

async function resolveApiKey(request: Request) {
    if (!ENABLE_API_KEYS) return null;
    const auth = request.headers.get('authorization') || '';
    let token: string | null = null;
    if (/^bearer /i.test(auth)) token = auth.slice(7).trim();
    else token = request.headers.get('x-api-key');
    if (!token) return null; // absence handled separately (auth required?)
    const cached = apiKeyCache.get(token);
    if (cached && cached.expiresAt > Date.now()) return cached.record;
    const rec = await apiKeys.verify(token);
    if (rec)
        apiKeyCache.set(token, {
            record: rec,
            expiresAt: Date.now() + API_KEY_CACHE_TTL_MS,
        });
    return rec;
}

function clientIdentity(request: Request, apiKeyId?: string | null): string {
    if (apiKeyId) return `key:${apiKeyId}`;
    const xf = request.headers.get('x-forwarded-for');
    if (xf) return `ip:${xf.split(',')[0]!.trim()}`;
    const xr = request.headers.get('x-real-ip');
    if (xr) return `ip:${xr}`;
    return 'ip:anon';
}

// Correlation id middleware MUST be early (Req 7.1)
const baseApp = new Elysia().onRequest(({ request, store, set }) => {
    const cid = request.headers.get('x-request-id') || crypto.randomUUID();
    (store as any).correlationId = cid;
    (store as any).__reqStart = performance.now();
    // propagate header
    set.headers['x-correlation-id'] = cid;
});

// HTTP metrics names:
// http.requests_total{method,route,code_class}
// http.errors_total{route,code}
// http.request_latency_ms{route}
export const app = addHttpInstrumentation(baseApp)
    .use(cors())
    .state('correlationId', '')
    // After each handler finalize metrics (onAfterHandle does not catch thrown errors w/ set? Use onResponse hook)
    .onAfterHandle(({ store, path, request, set, response }) => {
        try {
            const started = (store as any).__reqStart as number | undefined;
            if (started === undefined) return;
            const rt = performance.now() - started;
            const method = request.method;
            const route = normalizeRoute(path);
            const rawStatus: any =
                set.status || (response as any)?.status || 200;
            const code =
                typeof rawStatus === 'number'
                    ? rawStatus
                    : Number(rawStatus) || 200;
            const codeClass = `${Math.floor(code / 100)}xx`;
            metrics.inc('http.requests_total', 1, {
                method,
                route,
                code_class: codeClass,
            });
            metrics.observe('http.request_latency_ms', rt, { route });
            if (code >= 400) {
                metrics.inc('http.errors_total', 1, { route, code });
            }
        } catch {}
    })
    // onError hook catches exceptions & explicit error responses
    .onError(({ store, error, path, request, set }) => {
        try {
            const method = request.method;
            const route = normalizeRoute(path);
            const rawStatus: any = set.status || 500;
            const code =
                typeof rawStatus === 'number'
                    ? rawStatus
                    : Number(rawStatus) || 500;
            const codeClass = `${Math.floor(code / 100)}xx`;
            // ensure request counter still increments on error (if not already)
            metrics.inc('http.requests_total', 1, {
                method,
                route,
                code_class: codeClass,
            });
            metrics.inc('http.errors_total', 1, { route, code });
        } catch {}
        return error;
    })
    // Attach auth info (if enabled) early
    .onBeforeHandle(async ({ request, store, set, path }) => {
        if (!ENABLE_API_KEYS) return; // feature disabled
        // exempt health & metrics endpoints
        if (/^\/(healthz|metrics)/.test(path)) return;
        const rec = await resolveApiKey(request);
        if (!rec) {
            set.status = 401;
            return {
                error: {
                    code: 'UNAUTHORIZED',
                    message: 'API key required or invalid',
                    correlationId: (store as any).correlationId,
                },
            } satisfies ApiErrorEnvelope;
        }
        (store as any).apiKeyId = rec.id;
    })
    .get('/healthz', async ({ store }) => {
        const correlationId = (store as any).correlationId;
        // Queue health
        let queueHealth: any = { ok: false, error: 'uninitialized' };
        try {
            queueHealth = await queue.health();
        } catch (e) {
            queueHealth = {
                ok: false,
                error: e instanceof Error ? e.message : String(e),
            };
        }
        // DB ping latency (simple SELECT 1)
        let dbMs = -1;
        let dbOk = false;
        try {
            const start = performance.now();
            // Use jobsRepo (drizzle) low-level query; drizzle .execute needs a sql template.
            // Use a raw query through the adapter's underlying client if available.
            // Fallback: listByStatus with 0 limit as lightweight ping.
            await jobsRepo.listByStatus('queued', 1, 0);
            dbMs = performance.now() - start;
            dbOk = true;
        } catch (e) {
            dbOk = false;
        }
        const ok = queueHealth.ok && dbOk;
        return {
            ok,
            queue: queueHealth,
            db: { ok: dbOk, ping_ms: dbMs },
            correlationId,
        };
    })
    .get('/metrics/queue', ({ store }) => ({
        metrics: queue.getMetrics(),
        correlationId: (store as any).correlationId,
    }))
    .get('/metrics', ({ store }) => {
        const snap = metrics.snapshot();
        // merge queue metrics (Req 3.4)
        const queueMetrics = queue.getMetrics?.() || {};
        return {
            ...snap,
            queue: queueMetrics,
            correlationId: (store as any).correlationId,
        };
    })
    .get('/openapi.json', async ({ set }) => {
        try {
            const doc = await (
                await import('@clipper/contracts')
            ).maybeGenerateOpenApi();
            if (!doc) {
                set.status = 404;
                return { error: 'OpenAPI generation disabled' };
            }
            set.headers['content-type'] = 'application/json';
            return doc;
        } catch (e) {
            set.status = 500;
            return { error: 'Failed to generate OpenAPI document' };
        }
    })
    .post('/api/jobs', async ({ body, set, store, request }) => {
        const correlationId = (store as any).correlationId;
        // Rate limit (only on creation endpoint)
        try {
            const keyId = (store as any).apiKeyId || null;
            const ident = clientIdentity(request, keyId);
            const windowMs = RATE_WINDOW_SEC * 1000;
            if (rateLimitHit(ident, RATE_MAX, windowMs)) {
                return buildError(
                    set,
                    429,
                    'RATE_LIMITED',
                    'Rate limit exceeded',
                    correlationId
                );
            }
        } catch (e) {
            // Ignore limiter internal errors
        }
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
            // Env-driven validation & coercion
            const maxDurationSec = Number(readIntEnv('MAX_CLIP_SECONDS', 120));
            const minDurationSec = Number(
                readFloatEnv('MIN_DURATION_SEC', 0.5) ?? 0.5
            );
            const coerceMin = readBoolEnv('COERCE_MIN_DURATION', false);

            const validated = validateRange(input.start, input.end, {
                maxDurationSec,
            });
            if (!validated.ok) {
                if (validated.reason === 'duration_exceeds_cap') {
                    return buildError(
                        set,
                        400,
                        'CLIP_TOO_LONG',
                        `Clip exceeds MAX_CLIP_SECONDS (${maxDurationSec}s)`,
                        correlationId
                    );
                }
                return buildError(
                    set,
                    400,
                    'VALIDATION_FAILED',
                    'start must be before end and within max duration',
                    correlationId
                );
            }
            let { startSec, endSec } = validated;
            const coerced = coerceNearZeroDuration(startSec, endSec, {
                minDurationSec,
                coerce: coerceMin,
            });
            startSec = coerced.startSec;
            endSec = coerced.endSec;
            // Persist as integer seconds in DB; enforce end > start
            const startInt = Math.floor(startSec);
            let endInt = Math.ceil(endSec);
            if (endInt <= startInt) endInt = startInt + 1;
            const retentionHours = Number(readIntEnv('RETENTION_HOURS', 72));
            const expiresAt = new Date(Date.now() + retentionHours * 3600_000);
            const row = await jobsRepo.create({
                id,
                status: 'queued',
                progress: 0,
                sourceType: input.sourceType,
                sourceKey: input.uploadKey,
                sourceUrl: input.youtubeUrl,
                startSec: startInt,
                endSec: endInt,
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
                data: { correlationId },
            });
            const publishedAt = Date.now();
            await queue.publish({ jobId: id, priority: 'normal' });
            // jobs.created_total now incremented inside DrizzleJobsRepo.create()
            metrics.inc('jobs.created'); // legacy metric (optional)
            metrics.observe(
                'jobs.enqueue_latency_ms',
                Date.now() - publishedAt
            );
            log.info('job enqueued', {
                jobId: id,
                correlationId,
                apiKeyId: (store as any).apiKeyId,
            });
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
                    resultVideoBurnedKey:
                        (job as any).resultVideoBurnedKey ?? undefined,
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
            // If job failed, map worker error to stable API envelope
            if (job.status === 'failed') {
                const code = job.errorCode || 'INTERNAL';
                // Map worker/job error codes to HTTP
                const map: Record<
                    string,
                    { status: number; code: string; msg?: string }
                > = {
                    OUTPUT_VERIFICATION_FAILED: {
                        status: 422,
                        code: 'OUTPUT_VERIFICATION_FAILED',
                    },
                    SOURCE_UNREADABLE: {
                        status: 422,
                        code: 'SOURCE_UNREADABLE',
                    },
                    RETRYABLE_ERROR: { status: 503, code: 'RETRYABLE_ERROR' },
                    RETRIES_EXHAUSTED: {
                        status: 422,
                        code: 'RETRIES_EXHAUSTED',
                    },
                };
                const m = map[code] || { status: 500, code: 'INTERNAL' };
                return buildError(
                    set,
                    m.status,
                    m.code,
                    job.errorMessage || m.code,
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
            let burnedUrl: string | undefined;
            const burnedKey = (job as any).resultVideoBurnedKey;
            if (burnedKey) {
                try {
                    burnedUrl = await storage.sign(burnedKey);
                } catch {}
            }
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
                    burnedVideo:
                        burnedKey && burnedUrl
                            ? { key: burnedKey, url: burnedUrl }
                            : undefined,
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
    // Start lightweight resource sampler (CPU/mem/event-loop) (Req 6)
    startResourceSampler(metrics, { intervalMs: 15000 });
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
