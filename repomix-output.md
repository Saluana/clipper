This file is a merged representation of a subset of the codebase, containing files not matching ignore patterns, combined into a single document by Repomix.

# File Summary

## Purpose
This file contains a packed representation of the entire repository's contents.
It is designed to be easily consumable by AI systems for analysis, code review,
or other automated processes.

## File Format
The content is organized as follows:
1. This summary section
2. Repository information
3. Directory structure
4. Repository files (if enabled)
5. Multiple file entries, each consisting of:
  a. A header with the file path (## File: path/to/file)
  b. The full contents of the file in a code block

## Usage Guidelines
- This file should be treated as read-only. Any changes should be made to the
  original repository files, not this packed version.
- When processing this file, use the file path to distinguish
  between different files in the repository.
- Be aware that this file may contain sensitive information. Handle it with
  the same level of security as you would the original repository.

## Notes
- Some files may have been excluded based on .gitignore rules and Repomix's configuration
- Binary files are not included in this packed representation. Please refer to the Repository Structure section for a complete list of file paths, including binary files
- Files matching these patterns are excluded: **.test.ts
- Files matching patterns in .gitignore are excluded
- Files matching default ignore patterns are excluded
- Files are sorted by Git change count (files with more changes are at the bottom)

# Directory Structure
```
src/
  api/
    index.ts
  common/
    tests/
      common.test.js
    config.ts
    env.ts
    errors.ts
    index.ts
    logger.ts
    metrics.ts
    redact.ts
    state.ts
    time.ts
  contracts/
    index.ts
    openapi.ts
    schemas.ts
    types.ts
  data/
    db/
      connection.ts
      repos.ts
      schema.ts
    drizzle/
      meta/
        _journal.json
        0000_snapshot.json
      0000_tense_yellow_claw.sql
    scripts/
      admin-jobs.ts
      bootstrap-storage.ts
      cleanup.ts
      seed.ts
    api-keys.ts
    cleanup.ts
    index.ts
    media-io-upload.ts
    media-io-youtube.ts
    media-io.ts
    repo.ts
    storage.ts
  queue/
    dlq-consumer.ts
    index.ts
    pgboss.ts
    publish.ts
    types.ts
  worker/
    index.ts
.env.example
.gitignore
bunfig.toml
CLAUDE.md
drizzle.config.ts
index.ts
package.json
README.md
tsconfig.json
```

# Files

## File: src/api/index.ts
````typescript
import { Elysia, t } from 'elysia';
import cors from '@elysiajs/cors';
import { Schemas, type CreateJobInputType } from '@clipper/contracts';
import { createLogger, readEnv, readIntEnv, requireEnv } from '@clipper/common';
import { DrizzleJobsRepo, DrizzleJobEventsRepo, createDb } from '@clipper/data';
import { PgBossQueueAdapter } from '@clipper/queue';

const log = createLogger((readEnv('LOG_LEVEL') as any) || 'info').with({
    mod: 'api',
});

const jobsRepo = new DrizzleJobsRepo(createDb());
const eventsRepo = new DrizzleJobEventsRepo(createDb());
const queue = new PgBossQueueAdapter({
    connectionString: requireEnv('DATABASE_URL'),
});
await queue.start();

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

export const app = new Elysia()
    .use(cors())
    .get('/healthz', async () => {
        const h = await queue.health();
        return { ok: h.ok, queue: h };
    })
    .get('/metrics/queue', () => queue.getMetrics())
    .post('/api/jobs', async ({ body, set }) => {
        const parsed = Schemas.CreateJobInput.safeParse(body);
        if (!parsed.success) {
            set.status = 400;
            return {
                error: {
                    code: 'VALIDATION_FAILED',
                    message: parsed.error.message,
                },
            };
        }
        const input = parsed.data as CreateJobInputType;
        const id = crypto.randomUUID();
        const startSec = tcToSec(input.start);
        const endSec = tcToSec(input.end);
        if (endSec - startSec > Number(readIntEnv('MAX_CLIP_SECONDS', 120))) {
            set.status = 400;
            return {
                error: {
                    code: 'CLIP_TOO_LONG',
                    message: 'Clip exceeds MAX_CLIP_SECONDS',
                },
            };
        }
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
            expiresAt: undefined,
        });

        await eventsRepo.add({
            jobId: id,
            ts: new Date().toISOString(),
            type: 'created',
        });
        await queue.publish({ jobId: id, priority: 'normal' });

        return {
            id: row.id,
            status: row.status,
            expiresAt: new Date(
                Date.now() +
                    Number(readIntEnv('RETENTION_HOURS', 72)) * 3600_000
            ).toISOString(),
        };
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
````

## File: src/common/tests/common.test.js
````javascript
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../config';
import { parseTimecode, formatTimecode, validateRange } from '../time';
import { transition } from '../state';
describe('config loader', () => {
    it('loads valid config', () => {
        const cfg = loadConfig({
            NODE_ENV: 'test',
            LOG_LEVEL: 'debug',
            SUPABASE_URL: 'https://example.supabase.co',
            SUPABASE_ANON_KEY: 'aaaaaaaaaa',
            ENABLE_YTDLP: 'true',
            CLIP_MAX_DURATION_SEC: '120',
        });
        expect(cfg.ENABLE_YTDLP).toBe(true);
        expect(cfg.CLIP_MAX_DURATION_SEC).toBe(120);
    });
    it('throws on invalid config', () => {
        expect(() => loadConfig({})).toThrow();
    });
});
describe('time utils', () => {
    it('parses and formats timecode', () => {
        const s = parseTimecode('00:00:01.250');
        expect(s).toBeCloseTo(1.25, 3);
        expect(formatTimecode(s)).toBe('00:00:01.250');
    });
    it('validates range with cap', () => {
        const ok = validateRange('00:00:00', '00:00:10', {
            maxDurationSec: 15,
        });
        expect(ok.ok).toBe(true);
        const bad = validateRange('00:00:10', '00:00:09', {
            maxDurationSec: 15,
        });
        expect(bad.ok).toBe(false);
    });
});
describe('state machine', () => {
    it('allows valid transitions', () => {
        const t = transition('queued', 'processing');
        expect(t.from).toBe('queued');
        expect(t.to).toBe('processing');
    });
    it('rejects invalid transitions', () => {
        expect(() => transition('queued', 'done')).toThrow();
    });
});
````

## File: src/common/config.ts
````typescript
import { z } from 'zod';

export const ConfigSchema = z.object({
    NODE_ENV: z
        .enum(['development', 'test', 'production'])
        .default('development'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    SUPABASE_URL: z.string().url(),
    SUPABASE_ANON_KEY: z.string().min(10),
    QUEUE_URL: z.string().url().optional(),
    ENABLE_YTDLP: z.boolean().default(false),
    CLIP_MAX_DURATION_SEC: z.number().int().positive().default(120),
    // Media IO / Source Resolver
    SCRATCH_DIR: z.string().default('/tmp/ytc'),
    MAX_INPUT_MB: z.number().int().positive().default(1024),
    MAX_CLIP_INPUT_DURATION_SEC: z.number().int().positive().default(7200),
    ALLOWLIST_HOSTS: z.string().optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(
    env: Record<string, string | undefined> = process.env
): AppConfig {
    const parsed = ConfigSchema.safeParse({
        ...env,
        ENABLE_YTDLP: env.ENABLE_YTDLP === 'true',
        CLIP_MAX_DURATION_SEC: env.CLIP_MAX_DURATION_SEC
            ? Number(env.CLIP_MAX_DURATION_SEC)
            : undefined,
        MAX_INPUT_MB: env.MAX_INPUT_MB ? Number(env.MAX_INPUT_MB) : undefined,
        MAX_CLIP_INPUT_DURATION_SEC: env.MAX_CLIP_INPUT_DURATION_SEC
            ? Number(env.MAX_CLIP_INPUT_DURATION_SEC)
            : undefined,
    });
    if (!parsed.success) {
        const details = parsed.error.flatten();
        const redacted = Object.fromEntries(
            Object.entries(env).map(([k, v]) => [
                k,
                k.includes('KEY') ? '***' : v,
            ])
        );
        throw new Error(
            'Invalid configuration: ' +
                JSON.stringify({ details, env: redacted })
        );
    }
    return parsed.data;
}
````

## File: src/common/env.ts
````typescript
/**
 * Robust env access that prefers Bun.env (if present) and falls back to process.env.
 * This avoids jank when running under Bun vs Vitest's node environment.
 */
export function readEnv(key: string): string | undefined {
    // @ts-ignore
    const bunEnv =
        typeof Bun !== 'undefined'
            ? (Bun.env as Record<string, string | undefined>)
            : undefined;
    return bunEnv?.[key] ?? process.env[key];
}

export function requireEnv(key: string): string {
    const val = readEnv(key);
    if (val == null || val === '') {
        throw new Error(`Missing required env: ${key}`);
    }
    return val;
}

export function readIntEnv(
    key: string,
    defaultValue?: number
): number | undefined {
    const v = readEnv(key);
    if (v == null || v === '') return defaultValue;
    const n = Number(v);
    if (Number.isNaN(n)) return defaultValue;
    return n;
}
````

## File: src/common/errors.ts
````typescript
import { redactSecrets } from './redact';
export type ServiceErrorCode =
    | 'BAD_REQUEST'
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'RATE_LIMITED'
    | 'INTERNAL'
    | 'INVALID_STATE'
    | 'VALIDATION_FAILED';

export interface ErrorEnvelope {
    code: ServiceErrorCode;
    message: string;
    details?: unknown;
    correlationId?: string;
}

export class ServiceError extends Error {
    constructor(
        public code: ServiceErrorCode,
        message: string,
        public details?: unknown
    ) {
        super(message);
        this.name = 'ServiceError';
    }
}

export type Ok<T> = { ok: true; value: T };
export type Err = { ok: false; error: ErrorEnvelope };
export type ServiceResult<T> = Ok<T> | Err;

export function ok<T>(value: T): Ok<T> {
    return { ok: true, value };
}
export function err(
    code: ServiceErrorCode,
    message: string,
    details?: unknown,
    correlationId?: string
): Err {
    // Redact secrets in message/details
    return {
        ok: false,
        error: {
            code,
            message: redactSecrets(message),
            details: redactSecrets(details),
            correlationId,
        },
    };
}

export function fromException(e: unknown, correlationId?: string): Err {
    if (e instanceof ServiceError) {
        return err(e.code, e.message, e.details, correlationId);
    }
    const message = e instanceof Error ? e.message : String(e);
    return err('INTERNAL', message, undefined, correlationId);
}
````

## File: src/common/index.ts
````typescript
export * from './config';
export * from './logger';
export * from './errors';
export * from './time';
export * from './state';
export * from './env';
export * from './metrics';
export * from './redact';
````

## File: src/common/logger.ts
````typescript
import { redactSecrets } from './redact';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
    level: LogLevel;
    with(fields: Record<string, unknown>): Logger;
    debug(msg: string, fields?: Record<string, unknown>): void;
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
}

function emit(
    level: LogLevel,
    base: Record<string, unknown>,
    msg: string,
    fields?: Record<string, unknown>
) {
    const line = {
        level,
        ts: new Date().toISOString(),
        msg: redactSecrets(msg),
        ...redactSecrets(base),
        ...redactSecrets(fields ?? {}),
    };
    // eslint-disable-next-line no-console
    console[level === 'debug' ? 'log' : level](JSON.stringify(line));
}

export function createLogger(
    level: LogLevel = 'info',
    base: Record<string, unknown> = {}
): Logger {
    return {
        level,
        with(additional) {
            return createLogger(level, { ...base, ...additional });
        },
        debug(msg, fields) {
            if (['debug'].includes(level)) emit('debug', base, msg, fields);
        },
        info(msg, fields) {
            if (['debug', 'info'].includes(level))
                emit('info', base, msg, fields);
        },
        warn(msg, fields) {
            if (['debug', 'info', 'warn'].includes(level))
                emit('warn', base, msg, fields);
        },
        error(msg, fields) {
            emit('error', base, msg, fields);
        },
    };
}
````

## File: src/common/metrics.ts
````typescript
export type MetricLabels = Record<string, string | number>;

export interface Metrics {
    inc(name: string, value?: number, labels?: MetricLabels): void;
    observe(name: string, value: number, labels?: MetricLabels): void;
}

export class InMemoryMetrics implements Metrics {
    counters = new Map<string, number>();
    histograms = new Map<string, number[]>();
    inc(name: string, value = 1, labels?: MetricLabels) {
        const key = keyWithLabels(name, labels);
        this.counters.set(key, (this.counters.get(key) ?? 0) + value);
    }
    observe(name: string, value: number, labels?: MetricLabels) {
        const key = keyWithLabels(name, labels);
        const arr = this.histograms.get(key) ?? [];
        arr.push(value);
        this.histograms.set(key, arr);
    }
}

export const noopMetrics: Metrics = {
    inc() {},
    observe() {},
};

function keyWithLabels(name: string, labels?: MetricLabels) {
    if (!labels) return name;
    const parts = Object.entries(labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
    return `${name}{${parts}}`;
}
````

## File: src/common/redact.ts
````typescript
// Simple secret redaction utilities for logs and error messages.
// - Redacts API tokens in common places (Authorization headers, query params)
// - Redacts our ck_<id>_<secret> API key format
// - Redacts object properties whose keys look sensitive (token, secret, key, password)

const SENSITIVE_KEY_REGEX =
    /^(?:authorization|password|pass|secret|token|api[_-]?key|key)$/i;

function redactString(input: string): string {
    let out = input;
    // Bearer tokens
    out = out.replace(
        /Bearer\s+[A-Za-z0-9\-\._~\+\/]+=*/gi,
        'Bearer [REDACTED]'
    );
    // Query params like ?apikey=...&token=...
    out = out.replace(
        /([?&](?:api|apikey|token|key|secret)=)([^&#\s]+)/gi,
        '$1[REDACTED]'
    );
    // Our API key format: ck_<uuid>_<base64url>
    out = out.replace(
        /\bck_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]+)\b/gi,
        (_m, id) => `ck_${id}_[REDACTED]`
    );
    return out;
}

function redactArray(arr: unknown[]): unknown[] {
    return arr.map((v) => redactSecrets(v));
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = Array.isArray(obj) ? {} : {};
    for (const [k, v] of Object.entries(obj)) {
        if (SENSITIVE_KEY_REGEX.test(k)) {
            out[k] = '[REDACTED]';
            continue;
        }
        out[k] = redactSecrets(v);
    }
    return out;
}

export function redactSecrets<T = unknown>(value: T): T {
    if (value == null) return value;
    if (typeof value === 'string') return redactString(value) as unknown as T;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof Error) {
        const e = value as Error;
        const copy = new Error(redactString(e.message));
        (copy as any).name = e.name;
        (copy as any).stack = e.stack ? redactString(e.stack) : undefined;
        return copy as unknown as T;
    }
    if (Array.isArray(value)) return redactArray(value) as unknown as T;
    if (typeof value === 'object')
        return redactObject(value as any) as unknown as T;
    return value;
}

// Convenience for explicit string redaction when needed
export function redactText(text: string): string {
    return redactString(text);
}
````

## File: src/common/state.ts
````typescript
import type { JobStatus } from '@clipper/contracts';
import { ServiceError } from './errors';

export type Transition = {
    from: JobStatus;
    to: JobStatus;
    at: string;
    reason?: string;
};

const allowed: Record<JobStatus, JobStatus[]> = {
    queued: ['processing'],
    processing: ['done', 'failed'],
    done: [],
    failed: [],
};

export function transition(
    current: JobStatus,
    to: JobStatus,
    reason?: string
): Transition {
    if (current === to && (to === 'done' || to === 'failed')) {
        return { from: current, to, at: new Date().toISOString(), reason };
    }
    const next = allowed[current] || [];
    if (!next.includes(to)) {
        throw new ServiceError(
            'INVALID_STATE',
            `Invalid transition ${current} -> ${to}`
        );
    }
    return { from: current, to, at: new Date().toISOString(), reason };
}
````

## File: src/common/time.ts
````typescript
export function parseTimecode(tc: string): number {
    const m = tc.match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (!m) throw new Error('Invalid timecode');
    const [hh, mm, ss, ms] = [
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
        m[4] ? Number(m[4].padEnd(3, '0')) : 0,
    ];
    return hh * 3600 + mm * 60 + ss + ms / 1000;
}

export function formatTimecode(seconds: number): string {
    const sign = seconds < 0 ? '-' : '';
    const s = Math.abs(seconds);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    const core = `${hh.toString().padStart(2, '0')}:${mm
        .toString()
        .padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
    return ms
        ? `${sign}${core}.${ms.toString().padStart(3, '0')}`
        : `${sign}${core}`;
}

export function validateRange(
    startTc: string,
    endTc: string,
    opts: { maxDurationSec: number }
) {
    const start = parseTimecode(startTc);
    const end = parseTimecode(endTc);
    if (!(start < end))
        return { ok: false as const, reason: 'start_not_before_end' };
    if (end - start > opts.maxDurationSec)
        return { ok: false as const, reason: 'duration_exceeds_cap' };
    return { ok: true as const, startSec: start, endSec: end };
}
````

## File: src/contracts/index.ts
````typescript
export type {
    SourceType,
    JobStatus,
    CreateJobInput as CreateJobInputType,
    JobRecord,
} from './types';

export * as Schemas from './schemas';
export { maybeGenerateOpenApi } from './openapi';
````

## File: src/contracts/schemas.ts
````typescript
import { z } from 'zod';
import type { CreateJobInput as CreateJobInputType } from './types';

export const timecode = z
    .string()
    .regex(/^\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/, 'Expected HH:MM:SS(.ms)');

export const SourceType = z.enum(['upload', 'youtube']);
export const JobStatus = z.enum(['queued', 'processing', 'done', 'failed']);

export const CreateJobInput = z
    .object({
        sourceType: SourceType,
        youtubeUrl: z.string().url().optional(),
        uploadKey: z.string().min(1).optional(),
        start: timecode,
        end: timecode,
        withSubtitles: z.boolean().default(false),
        burnSubtitles: z.boolean().default(false),
        subtitleLang: z
            .union([z.literal('auto'), z.string().min(2)])
            .optional(),
    })
    .superRefine((val: CreateJobInputType, ctx) => {
        if (val.sourceType === 'upload' && !val.uploadKey) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'uploadKey required for sourceType=upload',
                path: ['uploadKey'],
            });
        }
        if (val.sourceType === 'youtube' && !val.youtubeUrl) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'youtubeUrl required for sourceType=youtube',
                path: ['youtubeUrl'],
            });
        }
    });

export const JobRecord = z.object({
    id: z.string().uuid(),
    status: JobStatus,
    progress: z.number().min(0).max(100),
    resultVideoKey: z.string().optional(),
    resultSrtKey: z.string().optional(),
    error: z.string().optional(),
    expiresAt: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
````

## File: src/contracts/types.ts
````typescript
export type SourceType = 'upload' | 'youtube';
export type JobStatus = 'queued' | 'processing' | 'done' | 'failed';

export interface CreateJobInput {
    sourceType: SourceType;
    youtubeUrl?: string;
    uploadKey?: string; // Supabase path
    start: string; // HH:MM:SS(.ms)
    end: string; // HH:MM:SS(.ms)
    withSubtitles: boolean;
    burnSubtitles: boolean;
    subtitleLang?: 'auto' | string;
}

export interface JobRecord {
    id: string;
    status: JobStatus;
    progress: number; // 0..100
    resultVideoKey?: string;
    resultSrtKey?: string;
    error?: string;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
}
````

## File: src/data/db/schema.ts
````typescript
import {
    pgEnum,
    pgTable,
    text,
    timestamp,
    uuid,
    integer,
    boolean,
    jsonb,
    index,
} from 'drizzle-orm/pg-core';

// Enums
export const jobStatus = pgEnum('job_status', [
    'queued',
    'processing',
    'done',
    'failed',
]);
export const sourceType = pgEnum('source_type', ['upload', 'youtube']);

// jobs table
export const jobs = pgTable(
    'jobs',
    {
        id: uuid('id').primaryKey(),
        status: jobStatus('status').notNull().default('queued'),
        progress: integer('progress').notNull().default(0),
        sourceType: sourceType('source_type').notNull(),
        sourceKey: text('source_key'),
        sourceUrl: text('source_url'),
        startSec: integer('start_sec').notNull(),
        endSec: integer('end_sec').notNull(),
        withSubtitles: boolean('with_subtitles').notNull().default(false),
        burnSubtitles: boolean('burn_subtitles').notNull().default(false),
        subtitleLang: text('subtitle_lang'),
        resultVideoKey: text('result_video_key'),
        resultSrtKey: text('result_srt_key'),
        errorCode: text('error_code'),
        errorMessage: text('error_message'),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        expiresAt: timestamp('expires_at', { withTimezone: true }),
    },
    (t) => [
        index('idx_jobs_status_created_at').on(t.status, t.createdAt),
        index('idx_jobs_expires_at').on(t.expiresAt),
    ]
);

// job_events table
export const jobEvents = pgTable(
    'job_events',
    {
        jobId: uuid('job_id')
            .notNull()
            .references(() => jobs.id, { onDelete: 'cascade' }),
        ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
        type: text('type').notNull(),
        data: jsonb('data'),
    },
    (t) => [index('idx_job_events_job_id_ts').on(t.jobId, t.ts)]
);

// api_keys table (optional)
export const apiKeys = pgTable('api_keys', {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(),
    revoked: boolean('revoked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobEvent = typeof jobEvents.$inferSelect;
export type NewJobEvent = typeof jobEvents.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
````

## File: src/data/drizzle/meta/_journal.json
````json
{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    {
      "idx": 0,
      "version": "7",
      "when": 1754887720633,
      "tag": "0000_tense_yellow_claw",
      "breakpoints": true
    }
  ]
}
````

## File: src/data/drizzle/meta/0000_snapshot.json
````json
{
  "id": "8b6622c6-d409-4478-942e-59689bb2473a",
  "prevId": "00000000-0000-0000-0000-000000000000",
  "version": "7",
  "dialect": "postgresql",
  "tables": {
    "public.api_keys": {
      "name": "api_keys",
      "schema": "",
      "columns": {
        "id": {
          "name": "id",
          "type": "uuid",
          "primaryKey": true,
          "notNull": true
        },
        "name": {
          "name": "name",
          "type": "text",
          "primaryKey": false,
          "notNull": true
        },
        "key_hash": {
          "name": "key_hash",
          "type": "text",
          "primaryKey": false,
          "notNull": true
        },
        "revoked": {
          "name": "revoked",
          "type": "boolean",
          "primaryKey": false,
          "notNull": true,
          "default": false
        },
        "created_at": {
          "name": "created_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        },
        "last_used_at": {
          "name": "last_used_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": false
        }
      },
      "indexes": {},
      "foreignKeys": {},
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.job_events": {
      "name": "job_events",
      "schema": "",
      "columns": {
        "job_id": {
          "name": "job_id",
          "type": "uuid",
          "primaryKey": false,
          "notNull": true
        },
        "ts": {
          "name": "ts",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        },
        "type": {
          "name": "type",
          "type": "text",
          "primaryKey": false,
          "notNull": true
        },
        "data": {
          "name": "data",
          "type": "jsonb",
          "primaryKey": false,
          "notNull": false
        }
      },
      "indexes": {
        "idx_job_events_job_id_ts": {
          "name": "idx_job_events_job_id_ts",
          "columns": [
            {
              "expression": "job_id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "ts",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            }
          ],
          "isUnique": false,
          "concurrently": false,
          "method": "btree",
          "with": {}
        }
      },
      "foreignKeys": {
        "job_events_job_id_jobs_id_fk": {
          "name": "job_events_job_id_jobs_id_fk",
          "tableFrom": "job_events",
          "tableTo": "jobs",
          "columnsFrom": [
            "job_id"
          ],
          "columnsTo": [
            "id"
          ],
          "onDelete": "cascade",
          "onUpdate": "no action"
        }
      },
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.jobs": {
      "name": "jobs",
      "schema": "",
      "columns": {
        "id": {
          "name": "id",
          "type": "uuid",
          "primaryKey": true,
          "notNull": true
        },
        "status": {
          "name": "status",
          "type": "job_status",
          "typeSchema": "public",
          "primaryKey": false,
          "notNull": true,
          "default": "'queued'"
        },
        "progress": {
          "name": "progress",
          "type": "integer",
          "primaryKey": false,
          "notNull": true,
          "default": 0
        },
        "source_type": {
          "name": "source_type",
          "type": "source_type",
          "typeSchema": "public",
          "primaryKey": false,
          "notNull": true
        },
        "source_key": {
          "name": "source_key",
          "type": "text",
          "primaryKey": false,
          "notNull": false
        },
        "source_url": {
          "name": "source_url",
          "type": "text",
          "primaryKey": false,
          "notNull": false
        },
        "start_sec": {
          "name": "start_sec",
          "type": "integer",
          "primaryKey": false,
          "notNull": true
        },
        "end_sec": {
          "name": "end_sec",
          "type": "integer",
          "primaryKey": false,
          "notNull": true
        },
        "with_subtitles": {
          "name": "with_subtitles",
          "type": "boolean",
          "primaryKey": false,
          "notNull": true,
          "default": false
        },
        "burn_subtitles": {
          "name": "burn_subtitles",
          "type": "boolean",
          "primaryKey": false,
          "notNull": true,
          "default": false
        },
        "subtitle_lang": {
          "name": "subtitle_lang",
          "type": "text",
          "primaryKey": false,
          "notNull": false
        },
        "result_video_key": {
          "name": "result_video_key",
          "type": "text",
          "primaryKey": false,
          "notNull": false
        },
        "result_srt_key": {
          "name": "result_srt_key",
          "type": "text",
          "primaryKey": false,
          "notNull": false
        },
        "error_code": {
          "name": "error_code",
          "type": "text",
          "primaryKey": false,
          "notNull": false
        },
        "error_message": {
          "name": "error_message",
          "type": "text",
          "primaryKey": false,
          "notNull": false
        },
        "created_at": {
          "name": "created_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        },
        "updated_at": {
          "name": "updated_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        },
        "expires_at": {
          "name": "expires_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": false
        }
      },
      "indexes": {
        "idx_jobs_status_created_at": {
          "name": "idx_jobs_status_created_at",
          "columns": [
            {
              "expression": "status",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "created_at",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            }
          ],
          "isUnique": false,
          "concurrently": false,
          "method": "btree",
          "with": {}
        },
        "idx_jobs_expires_at": {
          "name": "idx_jobs_expires_at",
          "columns": [
            {
              "expression": "expires_at",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            }
          ],
          "isUnique": false,
          "concurrently": false,
          "method": "btree",
          "with": {}
        }
      },
      "foreignKeys": {},
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    }
  },
  "enums": {
    "public.job_status": {
      "name": "job_status",
      "schema": "public",
      "values": [
        "queued",
        "processing",
        "done",
        "failed"
      ]
    },
    "public.source_type": {
      "name": "source_type",
      "schema": "public",
      "values": [
        "upload",
        "youtube"
      ]
    }
  },
  "schemas": {},
  "sequences": {},
  "roles": {},
  "policies": {},
  "views": {},
  "_meta": {
    "columns": {},
    "schemas": {},
    "tables": {}
  }
}
````

## File: src/data/drizzle/0000_tense_yellow_claw.sql
````sql
CREATE TYPE "public"."job_status" AS ENUM('queued', 'processing', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('upload', 'youtube');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"job_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"source_type" "source_type" NOT NULL,
	"source_key" text,
	"source_url" text,
	"start_sec" integer NOT NULL,
	"end_sec" integer NOT NULL,
	"with_subtitles" boolean DEFAULT false NOT NULL,
	"burn_subtitles" boolean DEFAULT false NOT NULL,
	"subtitle_lang" text,
	"result_video_key" text,
	"result_srt_key" text,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_job_events_job_id_ts" ON "job_events" USING btree ("job_id","ts");--> statement-breakpoint
CREATE INDEX "idx_jobs_status_created_at" ON "jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_jobs_expires_at" ON "jobs" USING btree ("expires_at");
````

## File: src/data/scripts/admin-jobs.ts
````typescript
import { eq, inArray } from 'drizzle-orm';
import { createDb } from '../db/connection';
import { jobs } from '../db/schema';
import { readEnv } from '@clipper/common';

type CloneCandidate = {
    id: string;
    status: string;
    sourceType: 'upload' | 'youtube';
    sourceKey: string | null;
    sourceUrl: string | null;
    startSec: number;
    endSec: number;
    withSubtitles: boolean;
    burnSubtitles: boolean;
    subtitleLang: string | null;
};

async function main() {
    // Inputs
    const argIds = process.argv.slice(2).filter(Boolean);
    const envIds = (readEnv('JOB_IDS') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const ids = (argIds.length ? argIds : envIds).filter(
        (v, i, a) => a.indexOf(v) === i
    );
    if (ids.length === 0) {
        console.error(
            'Usage: bun src/scripts/admin-jobs.ts <jobId...>\n  or: JOB_IDS="id1,id2" bun src/scripts/admin-jobs.ts'
        );
        process.exit(1);
    }
    const REQUEUE = (readEnv('REQUEUE') || 'true').toLowerCase() !== 'false';

    const db = createDb();

    // Fetch rows first (to know what to clone)
    const rows =
        ids.length === 1
            ? await db.select().from(jobs).where(eq(jobs.id, ids[0]!))
            : await db
                  .select()
                  .from(jobs)
                  .where(inArray(jobs.id, ids as string[]));

    if (rows.length === 0) {
        console.warn('[admin-jobs] No matching jobs found for provided IDs');
    }

    // Pick the first youtube job among the set as the clone candidate (if any)
    const yt: CloneCandidate | undefined = rows
        .map((r) => ({
            id: r.id,
            status: r.status,
            sourceType: r.sourceType,
            sourceKey: r.sourceKey,
            sourceUrl: r.sourceUrl,
            startSec: r.startSec,
            endSec: r.endSec,
            withSubtitles: r.withSubtitles,
            burnSubtitles: r.burnSubtitles,
            subtitleLang: r.subtitleLang,
        }))
        .find((r) => r.sourceType === 'youtube');

    // Delete all requested jobs; job_events cascades on delete
    const delCount = await db
        .delete(jobs)
        .where(
            ids.length === 1
                ? eq(jobs.id, ids[0]!)
                : inArray(jobs.id, ids as string[])
        );

    console.log('[admin-jobs] Deleted jobs', { ids, delCount });

    // Optionally requeue the youtube job by cloning its fields into a fresh row
    if (REQUEUE && yt) {
        const newId = crypto.randomUUID();
        const createdRows = await db
            .insert(jobs)
            .values({
                id: newId,
                status: 'queued',
                progress: 0,
                sourceType: 'youtube',
                sourceKey: yt.sourceKey,
                sourceUrl: yt.sourceUrl,
                startSec: yt.startSec,
                endSec: yt.endSec,
                withSubtitles: yt.withSubtitles,
                burnSubtitles: yt.burnSubtitles,
                subtitleLang: yt.subtitleLang,
                resultVideoKey: null,
                resultSrtKey: null,
                errorCode: null,
                errorMessage: null,
            })
            .returning();
        const created = createdRows[0]!;
        console.log('[admin-jobs] Requeued YouTube job', {
            oldId: yt.id,
            newId: created.id,
            sourceUrl: created.sourceUrl,
        });
    } else if (!yt) {
        console.log('[admin-jobs] No YouTube job among deleted IDs to requeue');
    } else {
        console.log('[admin-jobs] REQUEUE=false; skipping requeue');
    }
}

if (import.meta.main) {
    main().catch((err) => {
        console.error('[admin-jobs] Failed', err);
        process.exit(1);
    });
}
````

## File: src/data/scripts/bootstrap-storage.ts
````typescript
import { createClient } from '@supabase/supabase-js';
import { readEnv } from '@clipper/common';

export type BootstrapOptions = {
    url?: string;
    serviceRoleKey?: string;
    bucket: string;
    createPrefixes?: boolean; // creates sources/.keep and results/.keep
};

export async function bootstrapStorage(opts: BootstrapOptions) {
    const url = opts.url ?? readEnv('SUPABASE_URL');
    const key = opts.serviceRoleKey ?? readEnv('SUPABASE_SERVICE_ROLE_KEY');
    const bucket = opts.bucket;
    if (!url || !key) throw new Error('Missing SUPABASE_URL or SERVICE_ROLE');
    if (!bucket) throw new Error('Missing bucket name');

    const supabase = createClient(url, key);

    // Ensure bucket exists
    const { data: buckets, error: listErr } =
        await supabase.storage.listBuckets();
    if (listErr) throw new Error(`listBuckets failed: ${listErr.message}`);
    const exists = (buckets ?? []).some((b) => b.name === bucket);
    if (!exists) {
        const { error } = await supabase.storage.createBucket(bucket, {
            public: false,
        });
        if (error && !String(error.message).includes('already exists')) {
            throw new Error(`createBucket failed: ${error.message}`);
        }
    }

    // Optionally create prefix keep files
    if (opts.createPrefixes) {
        const mk = async (path: string) =>
            supabase.storage
                .from(bucket)
                .upload(path, new Blob([new Uint8Array(0)]), {
                    upsert: true,
                    contentType: 'application/octet-stream',
                })
                .then(({ error }) => {
                    if (
                        error &&
                        !String(error.message).includes('already exists')
                    )
                        throw new Error(
                            `upload ${path} failed: ${error.message}`
                        );
                });
        await mk('sources/.keep');
        await mk('results/.keep');
    }
}

// CLI entry
if (import.meta.main) {
    const bucket = readEnv('SUPABASE_STORAGE_BUCKET');
    bootstrapStorage({
        bucket: bucket!,
        createPrefixes: true,
    })
        .then(() => {
            console.log('Storage bootstrap complete');
        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
````

## File: src/data/scripts/cleanup.ts
````typescript
import { cleanupExpiredJobs } from '../cleanup';
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
    const res = await cleanupExpiredJobs({
        dryRun: DRY_RUN,
        batchSize: BATCH,
        rateLimitDelayMs: RATE_DELAY,
        storage,
        logger,
    });
    logger.info('cleanup finished', res as any);
}

if (import.meta.main) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
````

## File: src/data/scripts/seed.ts
````typescript
import { createDb } from '../db/connection';
import { jobs } from '../db/schema';

export async function seedMinimal() {
    const db = createDb();
    const id = crypto.randomUUID();
    await db.insert(jobs).values({
        id,
        status: 'queued',
        progress: 0,
        sourceType: 'upload',
        startSec: 0,
        endSec: 5,
        withSubtitles: false,
        burnSubtitles: false,
    });
    console.log('Seeded job:', id);
}

if (import.meta.main) {
    seedMinimal().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
````

## File: src/data/api-keys.ts
````typescript
import { createDb } from './db/connection';
import { apiKeys } from './db/schema';
import { eq } from 'drizzle-orm';

export interface ApiKeyRecord {
    id: string;
    name: string;
    revoked: boolean;
    createdAt: string;
    lastUsedAt?: string;
}

export interface ApiKeysRepository {
    issue(name: string): Promise<{ id: string; name: string; token: string }>;
    verify(token: string): Promise<ApiKeyRecord | null>;
    revoke(id: string): Promise<void>;
}

function ensureBunPassword() {
    const bun: any = (globalThis as any).Bun;
    if (!bun?.password) {
        throw new Error('BUN_PASSWORD_UNAVAILABLE: Bun.password is required');
    }
    return bun.password as {
        hash: (pw: string | ArrayBufferView, opts?: any) => Promise<string>;
        verify: (
            pw: string | ArrayBufferView,
            hash: string
        ) => Promise<boolean>;
    };
}

function generateTokenParts() {
    const id = crypto.randomUUID();
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const secret = Buffer.from(bytes).toString('base64url');
    return { id, secret };
}

function packToken(id: string, secret: string) {
    return `ck_${id}_${secret}`;
}

function unpackToken(token: string): { id: string; secret: string } | null {
    if (!token.startsWith('ck_')) return null;
    const parts = token.split('_');
    if (parts.length < 3) return null;
    const id = parts[1]!;
    const secret = parts.slice(2).join('_');
    if (!id || !secret) return null;
    return { id, secret };
}

export class DrizzleApiKeysRepo implements ApiKeysRepository {
    constructor(private readonly db = createDb()) {}

    async issue(
        name: string
    ): Promise<{ id: string; name: string; token: string }> {
        const { id, secret } = generateTokenParts();
        const token = packToken(id, secret);
        const bunPwd = ensureBunPassword();
        const hash = await bunPwd.hash(secret);
        await this.db
            .insert(apiKeys)
            .values({ id, name, keyHash: hash, revoked: false });
        return { id, name, token };
    }

    async verify(token: string): Promise<ApiKeyRecord | null> {
        const parsed = unpackToken(token);
        if (!parsed) return null;
        const [rec] = await this.db
            .select()
            .from(apiKeys)
            .where(eq(apiKeys.id, parsed.id))
            .limit(1);
        if (!rec || rec.revoked) return null;
        const bunPwd = ensureBunPassword();
        const ok = await bunPwd.verify(parsed.secret, rec.keyHash);
        if (!ok) return null;
        await this.db
            .update(apiKeys)
            .set({ lastUsedAt: new Date() })
            .where(eq(apiKeys.id, rec.id));
        return {
            id: rec.id,
            name: rec.name,
            revoked: rec.revoked,
            createdAt: rec.createdAt.toISOString(),
            lastUsedAt: rec.lastUsedAt?.toISOString(),
        };
    }

    async revoke(id: string): Promise<void> {
        await this.db
            .update(apiKeys)
            .set({ revoked: true })
            .where(eq(apiKeys.id, id));
    }
}
````

## File: src/data/index.ts
````typescript
export * from './repo';
export * as dbSchema from './db/schema';
export * from './db/connection';
export * from './db/repos';
export * from './storage';
export * from './cleanup';
export * from './api-keys';
export * from './media-io';
export { resolveUploadSource } from './media-io-upload';
export { resolveYouTubeSource } from './media-io-youtube';
````

## File: src/data/media-io.ts
````typescript
export interface ResolveResult {
    localPath: string;
    cleanup: () => Promise<void>;
    meta: { durationSec: number; sizeBytes: number; container?: string };
}

export interface SourceResolver {
    resolve(job: {
        id: string;
        sourceType: 'upload' | 'youtube';
        sourceKey?: string; // Supabase path (for uploads)
        sourceUrl?: string; // External URL (YouTube)
    }): Promise<ResolveResult>;
}
````

## File: src/data/repo.ts
````typescript
import type { JobStatus } from '@clipper/contracts';

export interface JobRow {
    id: string;
    status: JobStatus;
    progress: number;
    sourceType: 'upload' | 'youtube';
    sourceKey?: string;
    sourceUrl?: string;
    startSec: number;
    endSec: number;
    withSubtitles: boolean;
    burnSubtitles: boolean;
    subtitleLang?: string;
    resultVideoKey?: string;
    resultSrtKey?: string;
    errorCode?: string;
    errorMessage?: string;
    createdAt: string;
    updatedAt: string;
    expiresAt?: string;
}

export interface JobEvent {
    jobId: string;
    ts: string;
    type: string;
    data?: Record<string, unknown>;
}

export interface JobsRepository {
    create(row: Omit<JobRow, 'createdAt' | 'updatedAt'>): Promise<JobRow>;
    get(id: string): Promise<JobRow | null>;
    update(id: string, patch: Partial<JobRow>): Promise<JobRow>;
    listByStatus(
        status: JobStatus,
        limit?: number,
        offset?: number
    ): Promise<JobRow[]>;
    transition(
        id: string,
        next: JobStatus,
        event?: { type?: string; data?: Record<string, unknown> }
    ): Promise<JobRow>;
}

export interface JobEventsRepository {
    add(evt: JobEvent): Promise<void>;
    list(jobId: string, limit?: number, offset?: number): Promise<JobEvent[]>;
}

// Minimal in-memory impl to wire API/worker until DB is added
export class InMemoryJobsRepo implements JobsRepository {
    private map = new Map<string, JobRow>();
    async create(
        row: Omit<JobRow, 'createdAt' | 'updatedAt'>
    ): Promise<JobRow> {
        const now = new Date().toISOString();
        const rec: JobRow = { ...row, createdAt: now, updatedAt: now };
        this.map.set(rec.id, rec);
        return rec;
    }
    async get(id: string) {
        return this.map.get(id) ?? null;
    }
    async update(id: string, patch: Partial<JobRow>): Promise<JobRow> {
        const cur = this.map.get(id);
        if (!cur) throw new Error('NOT_FOUND');
        const next = {
            ...cur,
            ...patch,
            updatedAt: new Date().toISOString(),
        } as JobRow;
        this.map.set(id, next);
        return next;
    }
    async listByStatus(
        status: JobStatus,
        limit = 50,
        offset = 0
    ): Promise<JobRow[]> {
        return Array.from(this.map.values())
            .filter((r) => r.status === status)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .slice(offset, offset + limit);
    }
    async transition(
        id: string,
        next: JobStatus,
        event?: { type?: string; data?: Record<string, unknown> }
    ): Promise<JobRow> {
        const cur = await this.get(id);
        if (!cur) throw new Error('NOT_FOUND');
        const updated = await this.update(id, { status: next });
        // no-op event store here; handled by InMemoryJobEventsRepo
        return updated;
    }
}

export class InMemoryJobEventsRepo implements JobEventsRepository {
    private events: JobEvent[] = [];
    async add(evt: JobEvent): Promise<void> {
        this.events.push(evt);
    }
    async list(jobId: string, limit = 100, offset = 0): Promise<JobEvent[]> {
        return this.events
            .filter((e) => e.jobId === jobId)
            .sort((a, b) => a.ts.localeCompare(b.ts))
            .slice(offset, offset + limit);
    }
}
````

## File: src/queue/dlq-consumer.ts
````typescript
import PgBoss from 'pg-boss';
import {
    createLogger,
    type LogLevel,
    readEnv,
    readIntEnv,
    requireEnv,
} from '@clipper/common';

const envLevel = readEnv('LOG_LEVEL');
const level: LogLevel =
    envLevel === 'debug' ||
    envLevel === 'info' ||
    envLevel === 'warn' ||
    envLevel === 'error'
        ? envLevel
        : 'info';
const log = createLogger(level).with({ mod: 'queue-dlq' });

export async function startDlqConsumer(opts?: {
    connectionString?: string;
    schema?: string;
    queueName?: string;
    concurrency?: number;
}) {
    const connectionString =
        opts?.connectionString || requireEnv('DATABASE_URL');
    const schema = opts?.schema || readEnv('PG_BOSS_SCHEMA') || 'pgboss';
    const topic = (opts?.queueName ||
        readEnv('QUEUE_NAME') ||
        'clips') as string;
    const dlqTopic = `${topic}.dlq`;
    const concurrency = Number(
        opts?.concurrency || readIntEnv('QUEUE_CONCURRENCY', 2)
    );

    const boss = new PgBoss({ connectionString, schema });
    await boss.start();
    log.info('DLQ consumer started', { dlqTopic, concurrency });

    await boss.work(dlqTopic, { batchSize: concurrency }, async (jobs) => {
        for (const job of jobs) {
            const payload = job.data as Record<string, unknown>;
            log.error('DLQ message received', { jobId: job.id, payload });
            // TODO: integrate alerting (pager/email/webhook) here if desired
        }
    });

    return async () => {
        log.info('DLQ consumer stopping');
        await boss.stop();
    };
}
````

## File: src/queue/index.ts
````typescript
export * from './types';
export * from './pgboss';
export * from './dlq-consumer';
````

## File: src/queue/pgboss.ts
````typescript
import PgBoss from 'pg-boss';
import { readEnv, readIntEnv } from '@clipper/common';
import type { QueueAdapter, QueueMessage, QueuePriority } from './types';

const priorityMap: Record<QueuePriority, number> = {
    fast: 10,
    normal: 50,
    bulk: 90,
};

export class PgBossQueueAdapter implements QueueAdapter {
    private boss?: PgBoss;
    private topic: string;
    private dlqTopic: string;
    private metrics = {
        publishes: 0,
        claims: 0,
        completes: 0,
        retries: 0,
        errors: 0,
        dlq: 0,
    };

    constructor(
        private readonly opts: {
            connectionString: string;
            schema?: string;
            queueName?: string;
            concurrency?: number;
            visibilityTimeoutSec?: number;
            maxAttempts?: number;
        }
    ) {
        this.topic = opts.queueName ?? readEnv('QUEUE_NAME') ?? 'clips';
        this.dlqTopic = `${this.topic}.dlq`;
    }

    async start() {
        if (this.boss) return;
        this.boss = new PgBoss({
            connectionString: this.opts.connectionString,
            schema: this.opts.schema ?? readEnv('PG_BOSS_SCHEMA') ?? 'pgboss',
        });
        this.boss.on('error', (err) => {
            // Increment error metric on boss-level errors
            this.metrics.errors++;
            // Avoid importing logger to keep package lean; rely on caller logs
            console.error('[pgboss] error', err);
        });
        await this.boss.start();
        // Ensure queues exist with basic policies
        const expireInSeconds = Math.max(
            1,
            Math.floor(
                Number(
                    readIntEnv(
                        'QUEUE_VISIBILITY_SEC',
                        this.opts.visibilityTimeoutSec ?? 90
                    )
                )
            )
        );
        const retryLimit = Number(
            readIntEnv('QUEUE_MAX_ATTEMPTS', this.opts.maxAttempts ?? 3)
        );
        try {
            await this.boss.createQueue(this.topic, {
                name: this.topic,
                expireInSeconds,
                retryLimit,
                deadLetter: this.dlqTopic,
            });
        } catch (err) {
            // Intentionally ignore errors if the queue already exists
            // console.error('Error creating queue:', err);
        }
        try {
            await this.boss.createQueue(this.dlqTopic, {
                name: this.dlqTopic,
                expireInSeconds: expireInSeconds * 2,
                retryLimit: 0,
            });
        } catch {}
    }

    async publish(
        msg: QueueMessage,
        opts?: { timeoutSec?: number }
    ): Promise<void> {
        if (!this.boss) await this.start();
        const expireInSeconds = Math.max(
            1,
            Math.floor(
                opts?.timeoutSec ??
                    Number(
                        readIntEnv(
                            'QUEUE_VISIBILITY_SEC',
                            this.opts.visibilityTimeoutSec ?? 90
                        )
                    )
            )
        );
        const attemptLimit = Number(
            readIntEnv('QUEUE_MAX_ATTEMPTS', this.opts.maxAttempts ?? 3)
        );
        const priority = priorityMap[msg.priority ?? 'normal'];
        await this.boss!.send(this.topic, msg as object, {
            priority,
            expireInSeconds,
            retryLimit: attemptLimit,
            retryBackoff: true,
            deadLetter: this.dlqTopic,
        });
        this.metrics.publishes++;
    }

    async consume(
        handler: (msg: QueueMessage) => Promise<void>
    ): Promise<void> {
        if (!this.boss) await this.start();
        const batchSize = Number(
            readIntEnv('QUEUE_CONCURRENCY', this.opts.concurrency ?? 4)
        );
        await this.boss!.work<QueueMessage>(
            this.topic,
            { batchSize },
            async (jobs) => {
                for (const job of jobs) {
                    this.metrics.claims++;
                    try {
                        await handler(job.data as QueueMessage);
                        this.metrics.completes++;
                    } catch (err) {
                        // A thrown error triggers retry/DLQ in pg-boss
                        this.metrics.retries++;
                        this.metrics.errors++;
                        throw err;
                    }
                }
                // Throw inside handler to trigger retry; returning resolves completions
            }
        );
    }

    async shutdown(): Promise<void> {
        if (this.boss) {
            await this.boss.stop();
            this.boss = undefined;
        }
    }

    async health(): Promise<{ ok: boolean; error?: string }> {
        try {
            if (!this.boss) await this.start();
            // Simple ping by fetching the state; if it throws, not healthy
            // getQueue takes a name and returns settings; use topic
            await this.boss!.getQueue(this.topic);
            return { ok: true };
        } catch (e) {
            return {
                ok: false,
                error: e instanceof Error ? e.message : String(e),
            };
        }
    }

    getMetrics() {
        return { ...this.metrics };
    }
}
````

## File: src/queue/publish.ts
````typescript
import { PgBossQueueAdapter } from './pgboss';
import { requireEnv } from '@clipper/common';

async function main() {
    const jobId = process.argv[2] || process.env.JOB_ID;
    if (!jobId) {
        console.error('Usage: bun src/publish.ts <jobId> or JOB_ID=<id>');
        process.exit(1);
    }
    const queue = new PgBossQueueAdapter({
        connectionString: requireEnv('DATABASE_URL'),
    });
    await queue.publish({ jobId, priority: 'normal' });
    console.log('[publish] sent', { jobId });
    await queue.shutdown();
}

if (import.meta.main) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
````

## File: src/queue/types.ts
````typescript
export type QueuePriority = 'fast' | 'normal' | 'bulk';

export interface QueueMessage {
    jobId: string;
    priority?: QueuePriority;
}

export interface QueueAdapter {
    publish(msg: QueueMessage, opts?: { timeoutSec?: number }): Promise<void>;
    consume(handler: (msg: QueueMessage) => Promise<void>): Promise<void>;
    shutdown(): Promise<void>;
    start(): Promise<void>;
    health(): Promise<{ ok: boolean; error?: string }>;
    getMetrics(): {
        publishes: number;
        claims: number;
        completes: number;
        retries: number;
        errors: number;
        dlq: number;
    };
}
````

## File: src/worker/index.ts
````typescript
import { createLogger, readEnv, requireEnv } from '@clipper/common';
import { DrizzleJobsRepo, DrizzleJobEventsRepo, createDb } from '@clipper/data';
import { PgBossQueueAdapter } from '@clipper/queue';

const log = createLogger((readEnv('LOG_LEVEL') as any) || 'info').with({
    mod: 'worker',
});

const jobs = new DrizzleJobsRepo(createDb());
const events = new DrizzleJobEventsRepo(createDb());
const queue = new PgBossQueueAdapter({
    connectionString: requireEnv('DATABASE_URL'),
});

async function main() {
    await queue.start();
    await queue.consume(async ({ jobId }: { jobId: string }) => {
        // idempotency: if already done, short-circuit
        const row = await jobs.get(jobId);
        if (!row) {
            log.warn('job not found', { jobId });
            return;
        }
        if (row.status === 'done') return;

        await jobs.update(jobId, { status: 'processing', progress: 5 });
        await events.add({
            jobId,
            ts: new Date().toISOString(),
            type: 'processing',
        });

        // simulate work & progress updates
        await jobs.update(jobId, { progress: 50 });
        await events.add({
            jobId,
            ts: new Date().toISOString(),
            type: 'progress',
            data: { pct: 50, stage: 'trim' },
        });

        await jobs.update(jobId, { progress: 100, status: 'done' });
        await events.add({ jobId, ts: new Date().toISOString(), type: 'done' });
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
````

## File: .env.example
````
## Example .env for yt-clipper
# Copy to .env and fill in required values. Never commit real secrets.

SIGNED_URL_TTL_SEC=600
RETENTION_HOURS=72
MAX_CLIP_SECONDS=120
LOG_LEVEL=info
ADMIN_ENABLED=false

# --- Database / Supabase ---
# Fill these with your project values (do not commit secrets publicly)
# DATABASE_URL format (example): postgres://user:password@host:5432/db?sslmode=require
DATABASE_URL=postgresql://<user>:<password>@<host>:6543/postgres?sslmode=require
SUPABASE_URL=https://<your_project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your_supabase_service_role_key>
SUPABASE_SOURCES_BUCKET=sources
SUPABASE_RESULTS_BUCKET=results
SUPABASE_STORAGE_BUCKET=sources

# --- Queue (pg-boss) ---
QUEUE_PROVIDER=pgboss
PG_BOSS_SCHEMA=pgboss
QUEUE_NAME=clips
QUEUE_VISIBILITY_SEC=90
QUEUE_MAX_ATTEMPTS=3
QUEUE_RETRY_BACKOFF_MS_BASE=1000
QUEUE_RETRY_BACKOFF_MS_MAX=60000
QUEUE_CONCURRENCY=4
GROQ_API_KEY=
GROQ_MODEL=whisper-large-v3-turbo
NODE_ENV=development
DB_PASSWORD=

# --- Media IO / Resolver ---
# Local scratch directory for resolved sources (NVMe if available)
SCRATCH_DIR=/tmp/ytc
# Enable YouTube fetching via yt-dlp (false by default)
ENABLE_YTDLP=false
# Max input file size in megabytes (enforced by ffprobe / yt-dlp)
MAX_INPUT_MB=1024
# Max input duration in seconds (ffprobe validation)
MAX_CLIP_INPUT_DURATION_SEC=7200
# Optional comma-separated domain allowlist for external fetches
ALLOWLIST_HOSTS=

# Keep API clip limit for request validation (separate from input caps)
CLIP_MAX_DURATION_SEC=120
````

## File: .gitignore
````
# dependencies (bun install)
node_modules

# output
out
dist
*.tgz

# code coverage
coverage
*.lcov

# logs
logs
_.log
report.[0-9]_.[0-9]_.[0-9]_.[0-9]_.json

# dotenv environment variable files
.env
.env.development.local
.env.test.local
.env.production.local
.env.local

# caches
.eslintcache
.cache
*.tsbuildinfo

# IntelliJ based IDEs
.idea

# Finder (MacOS) folder config
.DS_Store
````

## File: bunfig.toml
````toml
# Resolve import aliases at runtime for Bun
# Matches tsconfig paths: "@clipper/*" -> "src/*"
[alias]
"@clipper/*" = "./src/*"
````

## File: CLAUDE.md
````markdown
---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";

// import .css files directly and it works
import './index.css';

import { createRoot } from "react-dom/client";

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.
````

## File: drizzle.config.ts
````typescript
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
    schema: './src/data/db/schema.ts',
    out: './src/data/drizzle',
    dialect: 'postgresql',
    dbCredentials: {
        url: process.env.DATABASE_URL!,
    },
    strict: true,
});
````

## File: index.ts
````typescript
console.log("Hello via Bun!");
````

## File: README.md
````markdown
# clipper

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.18. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
````

## File: tsconfig.json
````json
{
  "compilerOptions": {
    // Environment setup & latest features
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "jsx": "react-jsx",
    "allowJs": true,

    // Bundler mode
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,

    // Path aliases
    "baseUrl": ".",
    "paths": {
      "@clipper/*": ["src/*"]
    },

    // Best practices
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,

    // Some stricter flags (disabled by default)
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noPropertyAccessFromIndexSignature": false
  }
}
````

## File: src/contracts/openapi.ts
````typescript
// Optional OpenAPI generator: only use when env flag ENABLE_OPENAPI === 'true'
// We avoid importing 'zod-to-openapi' types at compile time to keep it optional.
import { z } from 'zod';
import { readEnv } from '../common/env';

export async function maybeGenerateOpenApi(): Promise<any | null> {
    if (readEnv('ENABLE_OPENAPI') !== 'true') return null;
    const { OpenAPIGenerator, extendZodWithOpenApi } = (await import(
        'zod-to-openapi'
    )) as any;
    extendZodWithOpenApi(z as any);
    const S = await import('./schemas');
    const registry = new OpenAPIGenerator(
        {
            CreateJobInput: S.CreateJobInput,
            JobRecord: S.JobRecord,
        },
        '3.0.0'
    );
    return registry.generateDocument({
        openapi: '3.0.0',
        info: { title: 'Clipper API', version: '1.0.0' },
        paths: {},
    });
}
````

## File: src/data/db/connection.ts
````typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { readEnv } from '../../common/index';

export type DB = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(url = readEnv('DATABASE_URL')): DB {
    if (!url) {
        throw new Error('DATABASE_URL is required');
    }
    const pool = new Pool({ connectionString: url });
    return drizzle(pool, { schema });
}
````

## File: src/data/db/repos.ts
````typescript
import { desc, eq } from 'drizzle-orm';
import { createDb } from './connection';
import { jobEvents, jobs } from './schema';
import type { JobStatus } from '@clipper/contracts';
import { createLogger, noopMetrics, type Metrics } from '../../common/index';
import type {
    JobEvent as RepoJobEvent,
    JobRow,
    JobEventsRepository,
    JobsRepository,
} from '../repo';

export class DrizzleJobsRepo implements JobsRepository {
    private readonly logger = createLogger('info').with({ comp: 'jobsRepo' });
    constructor(
        private readonly db = createDb(),
        private readonly metrics: Metrics = noopMetrics
    ) {}

    async create(
        row: Omit<JobRow, 'createdAt' | 'updatedAt'>
    ): Promise<JobRow> {
        const start = Date.now();
        const [rec] = await this.db
            .insert(jobs)
            .values({
                id: row.id,
                status: row.status,
                progress: row.progress,
                sourceType: row.sourceType,
                sourceKey: row.sourceKey,
                sourceUrl: row.sourceUrl,
                startSec: row.startSec,
                endSec: row.endSec,
                withSubtitles: row.withSubtitles,
                burnSubtitles: row.burnSubtitles,
                subtitleLang: row.subtitleLang,
                resultVideoKey: row.resultVideoKey,
                resultSrtKey: row.resultSrtKey,
                errorCode: row.errorCode,
                errorMessage: row.errorMessage,
                expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
            })
            .returning();
        const out = toJobRow(rec);
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'jobs.create',
        });
        this.logger.info('job created', { jobId: out.id });
        return out;
    }

    async get(id: string): Promise<JobRow | null> {
        const start = Date.now();
        const [rec] = await this.db
            .select()
            .from(jobs)
            .where(eq(jobs.id, id))
            .limit(1);
        const out = rec ? toJobRow(rec) : null;
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'jobs.get',
        });
        return out;
    }

    async update(id: string, patch: Partial<JobRow>): Promise<JobRow> {
        const start = Date.now();
        const [rec] = await this.db
            .update(jobs)
            .set(toJobsPatch(patch))
            .where(eq(jobs.id, id))
            .returning();
        if (!rec) throw new Error('NOT_FOUND');
        const row = toJobRow(rec);
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'jobs.update',
        });
        this.logger.info('job updated', { jobId: row.id });
        return row;
    }

    async listByStatus(
        status: JobStatus,
        limit = 50,
        offset = 0
    ): Promise<JobRow[]> {
        const start = Date.now();
        const rows = await this.db
            .select()
            .from(jobs)
            .where(eq(jobs.status, status))
            .orderBy(desc(jobs.createdAt))
            .limit(limit)
            .offset(offset);
        const out = rows.map(toJobRow);
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'jobs.listByStatus',
        });
        return out;
    }

    async transition(
        id: string,
        next: JobStatus,
        event?: { type?: string; data?: Record<string, unknown> }
    ): Promise<JobRow> {
        const start = Date.now();
        const res = await this.db.transaction(async (tx) => {
            const [updated] = await tx
                .update(jobs)
                .set({ status: next, updatedAt: new Date() })
                .where(eq(jobs.id, id))
                .returning();
            if (!updated) throw new Error('NOT_FOUND');

            if (event) {
                await tx.insert(jobEvents).values({
                    jobId: id,
                    type: event.type ?? `status:${next}`,
                    data: event.data ?? null,
                });
            }
            return toJobRow(updated);
        });
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'jobs.transition',
        });
        this.logger.info('job transitioned', { jobId: id, next });
        return res;
    }
}

export class DrizzleJobEventsRepo implements JobEventsRepository {
    constructor(
        private readonly db = createDb(),
        private readonly metrics: Metrics = noopMetrics
    ) {}

    async add(evt: RepoJobEvent): Promise<void> {
        const start = Date.now();
        await this.db.insert(jobEvents).values({
            jobId: evt.jobId,
            ts: new Date(evt.ts),
            type: evt.type,
            data: evt.data ?? null,
        });
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'events.add',
        });
    }

    async list(
        jobId: string,
        limit = 100,
        offset = 0
    ): Promise<RepoJobEvent[]> {
        const start = Date.now();
        const rows = await this.db
            .select()
            .from(jobEvents)
            .where(eq(jobEvents.jobId, jobId))
            .orderBy(desc(jobEvents.ts))
            .limit(limit)
            .offset(offset);
        const out = rows.map((r) => ({
            jobId: r.jobId,
            ts: r.ts.toISOString(),
            type: r.type,
            data: (r.data as Record<string, unknown> | null) ?? undefined,
        }));
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'events.list',
        });
        return out;
    }
}

function toJobRow(j: any): JobRow {
    return {
        id: j.id,
        status: j.status,
        progress: j.progress,
        sourceType: j.sourceType,
        sourceKey: j.sourceKey ?? undefined,
        sourceUrl: j.sourceUrl ?? undefined,
        startSec: j.startSec,
        endSec: j.endSec,
        withSubtitles: j.withSubtitles,
        burnSubtitles: j.burnSubtitles,
        subtitleLang: j.subtitleLang ?? undefined,
        resultVideoKey: j.resultVideoKey ?? undefined,
        resultSrtKey: j.resultSrtKey ?? undefined,
        errorCode: j.errorCode ?? undefined,
        errorMessage: j.errorMessage ?? undefined,
        createdAt: j.createdAt.toISOString(),
        updatedAt: j.updatedAt.toISOString(),
        expiresAt: j.expiresAt ? j.expiresAt.toISOString() : undefined,
    };
}

function toJobsPatch(patch: Partial<JobRow>) {
    const out: any = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (k === 'expiresAt' && v) out[k] = new Date(v as string);
        else out[k] = v as any;
    }
    return out;
}
````

## File: src/data/cleanup.ts
````typescript
import { createDb } from './db/connection';
import { jobs } from './db/schema';
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
````

## File: src/data/media-io-upload.ts
````typescript
import { createSupabaseStorageRepo } from './storage';
import {
    readEnv,
    readIntEnv,
    createLogger,
    noopMetrics,
    type Metrics,
} from '../common';
import type { ResolveResult as SharedResolveResult } from './media-io';

type ResolveJob = {
    id: string;
    sourceType: 'upload';
    sourceKey: string; // required for upload path
};

export type FfprobeMeta = {
    durationSec: number;
    sizeBytes: number;
    container?: string;
};

export type UploadResolveResult = SharedResolveResult;

async function streamToFile(
    url: string,
    outPath: string,
    metrics: Metrics,
    labels: Record<string, string>
) {
    const res = await fetch(url);
    if (!res.ok || !res.body) {
        throw new Error(`DOWNLOAD_FAILED: status=${res.status}`);
    }
    const counting = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            metrics.inc('mediaio.download.bytes', chunk.byteLength, labels);
            controller.enqueue(chunk);
        },
    });
    const stream = res.body.pipeThrough(counting);
    await Bun.write(outPath, new Response(stream));
}

async function ffprobe(localPath: string): Promise<FfprobeMeta> {
    const args = [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        localPath,
    ];
    const proc = Bun.spawn(['ffprobe', ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    if (exit !== 0) throw new Error('FFPROBE_FAILED');
    const json = JSON.parse(stdout);
    const durationSec = json?.format?.duration
        ? Number(json.format.duration)
        : 0;
    const sizeBytes = json?.format?.size
        ? Number(json.format.size)
        : Bun.file(localPath).size;
    const container = json?.format?.format_name as string | undefined;
    return { durationSec, sizeBytes, container };
}

export async function resolveUploadSource(
    job: ResolveJob,
    deps: { metrics?: Metrics } = {}
): Promise<UploadResolveResult> {
    const logger = createLogger((readEnv('LOG_LEVEL') as any) ?? 'info').with({
        comp: 'mediaio',
        jobId: job.id,
    });
    const metrics = deps.metrics ?? noopMetrics;

    const SCRATCH_DIR = readEnv('SCRATCH_DIR') ?? '/tmp/ytc';
    const MAX_MB = readIntEnv('MAX_INPUT_MB', 1024)!;
    const MAX_DUR = readIntEnv('MAX_CLIP_INPUT_DURATION_SEC', 7200)!;

    const m = job.sourceKey.match(/\.([A-Za-z0-9]+)$/);
    const ext = m ? `.${m[1]}` : '.mp4';
    const baseDir = `${SCRATCH_DIR.replace(/\/$/, '')}/sources/${job.id}`;
    const localPath = `${baseDir}/source${ext}`;

    logger.info('resolving upload to local path');
    {
        const p = Bun.spawn(['mkdir', '-p', baseDir]);
        const code = await p.exited;
        if (code !== 0) throw new Error('MKDIR_FAILED');
    }

    // Sign and stream download
    const storage = createSupabaseStorageRepo();
    const signedUrl = await storage.sign(job.sourceKey);
    await streamToFile(signedUrl, localPath, metrics, { jobId: job.id });

    // ffprobe validation
    const meta = await ffprobe(localPath);

    if (meta.durationSec > MAX_DUR || meta.sizeBytes > MAX_MB * 1024 * 1024) {
        // cleanup on violation
        const p = Bun.spawn(['rm', '-rf', baseDir]);
        await p.exited;
        throw new Error('INPUT_TOO_LARGE');
    }

    const cleanup = async () => {
        const p = Bun.spawn(['rm', '-rf', baseDir]);
        await p.exited;
    };

    logger.info('upload resolved', {
        durationSec: meta.durationSec,
        sizeBytes: meta.sizeBytes,
    });
    return { localPath, cleanup, meta };
}
````

## File: src/data/media-io-youtube.ts
````typescript
import {
    readEnv,
    readIntEnv,
    createLogger,
    noopMetrics,
    type Metrics,
} from '../common/index';
import type { ResolveResult as SharedResolveResult } from './media-io';
import { readdir } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';

type ResolveJob = {
    id: string;
    sourceType: 'youtube';
    sourceUrl: string; // required for youtube path
};

export type FfprobeMeta = {
    durationSec: number;
    sizeBytes: number;
    container?: string;
};

export type YouTubeResolveResult = SharedResolveResult;

function isPrivateIPv4(ip: string): boolean {
    if (!/^[0-9.]+$/.test(ip)) return false;
    const parts = ip.split('.').map((x) => Number(x));
    if (parts.length !== 4) return false;
    const a = parts[0]!;
    const b = parts[1]!;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 0) return true; // 0.0.0.0/8
    return false;
}

function isPrivateIPv6(ip: string): boolean {
    // very coarse checks
    const v = ip.toLowerCase();
    if (v === '::1') return true; // loopback
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // ULA fc00::/7
    if (v.startsWith('fe80:')) return true; // link-local fe80::/10
    if (v === '::' || v === '::0') return true; // unspecified
    return false;
}

async function assertSafeUrl(rawUrl: string) {
    let u: URL;
    try {
        u = new URL(rawUrl);
    } catch {
        throw new Error('SSRF_BLOCKED');
    }
    if (!/^https?:$/.test(u.protocol)) throw new Error('SSRF_BLOCKED');
    const allowlist = (readEnv('ALLOWLIST_HOSTS') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (allowlist.length > 0 && !allowlist.includes(u.hostname)) {
        throw new Error('SSRF_BLOCKED');
    }
    // Resolve host to IPs and block private/link-local
    try {
        const res = await lookup(u.hostname, { all: true });
        for (const { address, family } of res) {
            if (
                (family === 4 && isPrivateIPv4(address)) ||
                (family === 6 && isPrivateIPv6(address))
            )
                throw new Error('SSRF_BLOCKED');
        }
    } catch (e) {
        // If DNS fails, treat as blocked to be safe
        throw new Error('SSRF_BLOCKED');
    }
}

async function ffprobe(localPath: string): Promise<FfprobeMeta> {
    const args = [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        localPath,
    ];
    const proc = Bun.spawn(['ffprobe', ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    if (exit !== 0) throw new Error('FFPROBE_FAILED');
    const json = JSON.parse(stdout);
    const durationSec = json?.format?.duration
        ? Number(json.format.duration)
        : 0;
    const sizeBytes = json?.format?.size
        ? Number(json.format.size)
        : Bun.file(localPath).size;
    const container = json?.format?.format_name as string | undefined;
    return { durationSec, sizeBytes, container };
}

async function findDownloadedFile(baseDir: string): Promise<string | null> {
    const files = await readdir(baseDir).catch(() => []);
    const candidates = files.filter((f) => f.startsWith('source.'));
    if (candidates.length === 0) return null;
    // Prefer mp4 if present
    const mp4 = candidates.find((f) => f.endsWith('.mp4'));
    const chosen = mp4 ?? candidates[0];
    return `${baseDir}/${chosen}`;
}

export async function resolveYouTubeSource(
    job: ResolveJob,
    deps: { metrics?: Metrics } = {}
): Promise<YouTubeResolveResult> {
    const logger = createLogger((readEnv('LOG_LEVEL') as any) ?? 'info').with({
        comp: 'mediaio',
        jobId: job.id,
    });
    const metrics = deps.metrics ?? noopMetrics;

    const SCRATCH_DIR = readEnv('SCRATCH_DIR') ?? '/tmp/ytc';
    const MAX_MB = readIntEnv('MAX_INPUT_MB', 1024)!;
    const MAX_DUR = readIntEnv('MAX_CLIP_INPUT_DURATION_SEC', 7200)!;
    const ENABLE = (readEnv('ENABLE_YTDLP') ?? 'false') === 'true';

    const baseDir = `${SCRATCH_DIR.replace(/\/$/, '')}/sources/${job.id}`;
    const outTemplate = `${baseDir}/source.%(ext)s`;

    const resolveStart = Date.now();
    logger.info('resolving youtube to local path');

    if (!ENABLE) {
        logger.warn('yt-dlp disabled, rejecting request');
        throw new Error('YTDLP_DISABLED');
    }

    await assertSafeUrl(job.sourceUrl);

    {
        const p = Bun.spawn(['mkdir', '-p', baseDir]);
        const code = await p.exited;
        if (code !== 0) throw new Error('MKDIR_FAILED');
    }

    // Run yt-dlp
    const ytdlpArgs = [
        '-f',
        'bv*+ba/b',
        '-o',
        outTemplate,
        '--quiet',
        '--no-progress',
        '--no-cache-dir',
        '--no-part',
        '--retries',
        '3',
    ];
    if (MAX_MB && MAX_MB > 0) {
        ytdlpArgs.push('--max-filesize', `${MAX_MB}m`);
    }
    ytdlpArgs.push(job.sourceUrl);

    const ytdlpStart = Date.now();
    const proc = Bun.spawn(['yt-dlp', ...ytdlpArgs], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {}, // minimal env to avoid secret leaks
    });
    const timeoutMs = Math.min(MAX_DUR * 1000, 15 * 60 * 1000); // cap timeout to 15min
    let timedOut = false;
    const timeout = setTimeout(() => {
        try {
            proc.kill('SIGKILL');
            timedOut = true;
        } catch {}
    }, timeoutMs);

    const exitCode = await proc.exited;
    clearTimeout(timeout);
    metrics.observe('mediaio.ytdlp.duration_ms', Date.now() - ytdlpStart, {
        jobId: job.id,
    });

    if (timedOut) {
        // cleanup and throw
        const p = Bun.spawn(['rm', '-rf', baseDir]);
        await p.exited;
        throw new Error('YTDLP_TIMEOUT');
    }
    if (exitCode !== 0) {
        const p = Bun.spawn(['rm', '-rf', baseDir]);
        await p.exited;
        throw new Error('YTDLP_FAILED');
    }

    const localPath = await findDownloadedFile(baseDir);
    if (!localPath) {
        const p = Bun.spawn(['rm', '-rf', baseDir]);
        await p.exited;
        throw new Error('YTDLP_FAILED');
    }

    // ffprobe validation
    const ffStart = Date.now();
    const meta = await ffprobe(localPath);
    metrics.observe('mediaio.ffprobe.duration_ms', Date.now() - ffStart, {
        jobId: job.id,
    });

    if (meta.durationSec > MAX_DUR || meta.sizeBytes > MAX_MB * 1024 * 1024) {
        const p = Bun.spawn(['rm', '-rf', baseDir]);
        await p.exited;
        throw new Error('INPUT_TOO_LARGE');
    }

    const cleanup = async () => {
        const p = Bun.spawn(['rm', '-rf', baseDir]);
        await p.exited;
    };

    const totalMs = Date.now() - resolveStart;
    metrics.observe('mediaio.resolve.duration_ms', totalMs, {
        jobId: job.id,
    });
    logger.info('youtube resolved', {
        durationSec: meta.durationSec,
        sizeBytes: meta.sizeBytes,
        durationMs: totalMs,
    });

    return { localPath, cleanup, meta };
}
````

## File: src/data/storage.ts
````typescript
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readEnv } from '../common/index';

export const storageKeys = {
    source: (jobId: string, ext: string) =>
        `sources/${jobId}/source.${ext.replace(/^\./, '')}`,
    resultVideo: (jobId: string) => `results/${jobId}/clip.mp4`,
    resultSrt: (jobId: string) => `results/${jobId}/clip.srt`,
};

export interface StorageRepo {
    upload(localPath: string, key: string, contentType?: string): Promise<void>;
    sign(key: string, ttlSec?: number): Promise<string>;
    remove(key: string): Promise<void>;
}

export type SupabaseStorageOptions = {
    url?: string;
    serviceRoleKey?: string;
    bucket?: string;
    defaultTtlSec?: number; // default 600 (10 minutes)
    client?: SupabaseClient; // optional injection for testing
};

export function createSupabaseStorageRepo(
    opts: SupabaseStorageOptions = {}
): StorageRepo {
    const url = opts.url ?? readEnv('SUPABASE_URL');
    const key = opts.serviceRoleKey ?? readEnv('SUPABASE_SERVICE_ROLE_KEY');
    const bucket = opts.bucket ?? readEnv('SUPABASE_STORAGE_BUCKET');
    const ttlStr = readEnv('SIGNED_URL_TTL_SEC');
    const defaultTtlSec = opts.defaultTtlSec ?? (ttlStr ? Number(ttlStr) : 600);

    if (!url || !key || !bucket) {
        throw new Error(
            'Supabase storage not configured: require SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET'
        );
    }

    const client = opts.client ?? createClient(url, key);
    return new SupabaseStorageRepo(client, bucket, defaultTtlSec);
}

class SupabaseStorageRepo implements StorageRepo {
    constructor(
        private readonly supabase: SupabaseClient,
        private readonly bucket: string,
        private readonly defaultTtlSec: number
    ) {}

    async upload(
        localPath: string,
        key: string,
        contentType?: string
    ): Promise<void> {
        const type = contentType ?? guessContentType(key);
        const bun: any = (globalThis as any).Bun;
        const forceNode = readEnv('FORCE_NODE_FS') === '1';
        let blob: Blob;
        if (!forceNode && bun?.file) {
            const file = bun.file(localPath);
            if (!(await file.exists())) {
                throw new Error(`FILE_NOT_FOUND: ${localPath}`);
            }
            blob = new Blob([await file.arrayBuffer()], { type });
        } else {
            const { readFile } = await import('node:fs/promises');
            const data = await readFile(localPath);
            blob = new Blob([data], { type });
        }
        const { error } = await this.supabase.storage
            .from(this.bucket)
            .upload(key, blob, { upsert: true, contentType: blob.type });
        if (error) throw new Error(`STORAGE_UPLOAD_FAILED: ${error.message}`);
    }

    async sign(key: string, ttlSec?: number): Promise<string> {
        const { data, error } = await this.supabase.storage
            .from(this.bucket)
            .createSignedUrl(key, ttlSec ?? this.defaultTtlSec);
        if (error || !data?.signedUrl)
            throw new Error(
                `STORAGE_SIGN_FAILED: ${error?.message ?? 'unknown'}`
            );
        return data.signedUrl;
    }

    async remove(key: string): Promise<void> {
        const { error } = await this.supabase.storage
            .from(this.bucket)
            .remove([key]);
        if (error) throw new Error(`STORAGE_REMOVE_FAILED: ${error.message}`);
    }
}

function guessContentType(key: string): string {
    const lower = key.toLowerCase();
    if (lower.endsWith('.mp4')) return 'video/mp4';
    if (lower.endsWith('.mkv')) return 'video/x-matroska';
    if (lower.endsWith('.mov')) return 'video/quicktime';
    if (lower.endsWith('.webm')) return 'video/webm';
    if (lower.endsWith('.srt')) return 'application/x-subrip';
    if (lower.endsWith('.txt')) return 'text/plain; charset=utf-8';
    if (lower.endsWith('.json')) return 'application/json';
    return 'application/octet-stream';
}
````

## File: package.json
````json
{
    "name": "clipper",
    "module": "index.ts",
    "type": "module",
    "private": true,
    "scripts": {
        "test": "bunx vitest run",
        "db:generate": "bunx drizzle-kit generate --config=drizzle.config.ts",
        "db:migrate": "bunx drizzle-kit migrate --config=drizzle.config.ts",
        "db:push": "bunx drizzle-kit push --config=drizzle.config.ts"
    },
    "devDependencies": {
        "@types/bun": "latest"
    },
    "peerDependencies": {
        "typescript": "^5"
    },
    "dependencies": {
        "@elysiajs/cors": "^1.3.3",
        "@supabase/supabase-js": "^2.54.0",
        "@types/pg": "^8.15.5",
        "dotenv": "^17.2.1",
        "drizzle-kit": "^0.31.4",
        "drizzle-orm": "^0.44.4",
        "elysia": "^1.3.8",
        "pg": "^8.16.3",
        "pg-boss": "^10.3.2",
        "zod": "^4.0.17",
        "zod-to-openapi": "^0.2.1"
    }
}
````
