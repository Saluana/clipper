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
- Files matching these patterns are excluded: **.test.ts, **.md
- Files matching patterns in .gitignore are excluded
- Files matching default ignore patterns are excluded
- Files are sorted by Git change count (files with more changes are at the bottom)

# Directory Structure
```
scripts/
  dev-all.ts
  submit-and-poll.ts
src/
  api/
    index.ts
  asr/
    facade.ts
    formatter.ts
    index.ts
    provider.ts
  common/
    tests/
      common.test.js
    config.ts
    env.ts
    errors.ts
    external.ts
    index.ts
    logger.ts
    metrics.ts
    redact.ts
    resource-sampler.ts
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
        0002_snapshot.json
      0000_tense_yellow_claw.sql
      0001_asr_jobs.sql
      0002_add_last_heartbeat.sql
      0002_happy_nomad.sql
      0003_attempt_and_processing.sql
      0004_add_burned_video_key.sql
    scripts/
      admin-jobs.ts
      backfill-expires.ts
      bootstrap-storage.ts
      cleanup.ts
      seed.ts
      verify_burned_key.ts
    api-keys.ts
    cleanup.ts
    index.ts
    media-io-upload.ts
    media-io-youtube.ts
    media-io.ts
    repo.ts
    storage.ts
  ffmpeg/
    clipper.ts
    copy-decision.ts
    index.ts
    probe.ts
    progress.ts
    types.ts
    verify.ts
  queue/
    asr.ts
    dlq-consumer.ts
    index.ts
    pgboss.ts
    publish.ts
    types.ts
  test/
    setup.ts
  worker/
    asr.start.ts
    asr.ts
    cleanup.ts
    index.ts
    retry.ts
    stage.ts
.env.example
.gitignore
bunfig.toml
drizzle.config.ts
index.ts
package.json
tsconfig.json
vitest.config.ts
```

# Files

## File: scripts/dev-all.ts
```typescript
#!/usr/bin/env bun
/**
 * Dev orchestrator: runs API, worker, ASR worker, and DLQ consumer in watch mode.
 * Uses Bun.spawn to manage child processes; forwards signals for clean shutdown.
 */

type Proc = {
    label: string;
    p: ReturnType<typeof Bun.spawn>;
};

const procs: Proc[] = [];

async function run() {
    const cmds: { label: string; cmd: string[] }[] = [
        { label: 'api', cmd: ['bun', '--watch', 'src/api/index.ts'] },
        { label: 'worker', cmd: ['bun', '--watch', 'src/worker/index.ts'] },
        { label: 'asr', cmd: ['bun', '--watch', 'src/worker/asr.start.ts'] },
        { label: 'dlq', cmd: ['bun', '--watch', 'src/queue/dlq-consumer.ts'] },
    ];

    for (const { label, cmd } of cmds) {
        const child = Bun.spawn({
            cmd,
            stdout: 'inherit',
            stderr: 'inherit',
            stdin: 'inherit',
        });
        procs.push({ label, p: child });
        console.log(`[dev-all] started ${label} (pid ${child.pid})`);
    }

    const shutdown = async (signal: string) => {
        console.log(`\n[dev-all] received ${signal}, shutting down...`);
        for (const { label, p } of procs) {
            try {
                console.log(
                    `[dev-all] sending terminate to ${label} (pid ${p.pid})`
                );
                // Send default termination signal
                p.kill();
            } catch (err) {
                console.error(`[dev-all] error signaling ${label}:`, err);
            }
        }
        await Promise.allSettled(procs.map(({ p }) => p.exited));
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // If any child exits, shut down the rest and exit non-zero.
    await Promise.race(
        procs.map(({ label, p }) =>
            p.exited.then((code: number) => {
                console.error(`[dev-all] ${label} exited with code ${code}`);
                return { label, code } as const;
            })
        )
    );
    await shutdown('child-exit');
}

run().catch((err) => {
    console.error('[dev-all] fatal error:', err);
    process.exit(1);
});
```

## File: src/asr/formatter.ts
```typescript
import type { AsrProviderSegment } from './provider';

export interface BuildArtifactsOptions {
    includeJson?: boolean;
    mergeGapMs?: number; // default 150ms
    maxLineChars?: number; // default 120
}

export interface BuiltArtifacts {
    srt: string;
    text: string;
    json?: Array<{ start: number; end: number; text: string }>;
}

export function buildArtifacts(
    segments: AsrProviderSegment[],
    opts: BuildArtifactsOptions = {}
): BuiltArtifacts {
    const mergeGapMs = opts.mergeGapMs ?? 150;
    const maxLineChars = opts.maxLineChars ?? 120;

    const norm = normalizeSegments(segments);
    const merged = mergeSegments(norm, mergeGapMs, maxLineChars);
    const srt = buildSrt(merged);
    const text = merged
        .map((s) => s.text)
        .join(' ')
        .trim();
    const out: BuiltArtifacts = { srt, text };
    if (opts.includeJson) {
        out.json = merged.map((s) => ({
            start: s.startSec,
            end: s.endSec,
            text: s.text,
        }));
    }
    return out;
}

function normalizeSegments(inSegs: AsrProviderSegment[]): AsrProviderSegment[] {
    return inSegs
        .map((s) => ({
            startSec: clampNum(s.startSec, 0),
            endSec: clampNum(s.endSec, 0),
            text: sanitizeText(s.text),
            words: s.words?.map((w) => ({
                startSec: clampNum(w.startSec, 0),
                endSec: clampNum(w.endSec, 0),
                text: sanitizeText(w.text),
            })),
        }))
        .filter((s) => s.endSec > s.startSec && s.text.length > 0);
}

function mergeSegments(
    segs: AsrProviderSegment[],
    mergeGapMs: number,
    maxLineChars: number
): AsrProviderSegment[] {
    if (segs.length === 0) return [];
    const out: AsrProviderSegment[] = [];
    let cur: AsrProviderSegment = segs[0]!;
    for (let i = 1; i < segs.length; i++) {
        const next = segs[i]!;
        const gapMs = (next.startSec - cur.endSec) * 1000;
        const combinedLen = (cur.text + ' ' + next.text).length;
        if (gapMs < mergeGapMs && combinedLen <= maxLineChars) {
            cur = {
                startSec: cur.startSec,
                endSec: next.endSec,
                text: (cur.text + ' ' + next.text).trim().replace(/\s+/g, ' '),
            };
        } else {
            out.push(cur);
            cur = next;
        }
    }
    out.push(cur);
    return out;
}

export function buildSrt(segs: AsrProviderSegment[]): string {
    return segs
        .map((s, idx) => {
            const start = formatSrtTime(s.startSec, 'start');
            const end = formatSrtTime(s.endSec, 'end');
            const lines = wrapText(s.text);
            return `${idx + 1}\n${start} --> ${end}\n${lines}\n`;
        })
        .join('\n')
        .trim()
        .concat('\n');
}

function wrapText(t: string, width = 42): string {
    // simple greedy wrap to 1-2 lines if needed
    if (t.length <= width) return t;
    const words = t.split(/\s+/);
    let line = '';
    const lines: string[] = [];
    for (const w of words) {
        if ((line + ' ' + w).trim().length > width && line.length > 0) {
            lines.push(line.trim());
            line = w;
        } else {
            line += (line ? ' ' : '') + w;
        }
    }
    if (line) lines.push(line.trim());
    return lines.slice(0, 2).join('\n');
}

function formatSrtTime(sec: number, kind: 'start' | 'end'): string {
    // start floors ms; end ceils ms to avoid overlaps
    const msFloat = sec * 1000;
    const ms = kind === 'start' ? Math.floor(msFloat) : Math.ceil(msFloat);
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    const mm = (ms % 1000).toString().padStart(3, '0');
    return `${h.toString().padStart(2, '0')}:${m
        .toString()
        .padStart(2, '0')}:${s.toString().padStart(2, '0')},${mm}`;
}

function sanitizeText(t: string): string {
    // Normalize whitespace, remove control chars except \n
    const normalized = (t ?? '').normalize('NFKC');
    const stripped = normalized.replace(/[\u0000-\u001F\u007F]/g, (ch) =>
        ch === '\n' ? '\n' : ' '
    );
    return stripped.trim().replace(/\s+/g, ' ');
}

function clampNum(n: number, min: number): number {
    return Number.isFinite(n) ? Math.max(min, n) : min;
}
```

## File: src/asr/index.ts
```typescript
export * from './provider';
export * from './formatter';
export * from './facade';
```

## File: src/asr/provider.ts
```typescript
export interface AsrProviderSegment {
    startSec: number;
    endSec: number;
    text: string;
    words?: Array<{ startSec: number; endSec: number; text: string }>;
}

export interface AsrProviderResult {
    segments: AsrProviderSegment[];
    detectedLanguage?: string;
    modelVersion: string;
    durationSec: number;
}

export interface AsrProvider {
    transcribe(
        filePath: string,
        opts: { timeoutMs: number; signal?: AbortSignal; languageHint?: string }
    ): Promise<AsrProviderResult>;
}

export class ProviderHttpError extends Error {
    constructor(public status: number, public body?: string) {
        super(`Provider HTTP ${status}`);
        this.name = 'ProviderHttpError';
    }
}

export interface GroqWhisperConfig {
    apiKey?: string;
    model?: string;
    endpoint?: string;
    maxRetries?: number; // number of retry attempts on retryable errors
    initialBackoffMs?: number;
    maxBackoffMs?: number;
}

export class GroqWhisperProvider {
    private readonly apiKey: string;
    private readonly model: string;
    private readonly endpoint: string;
    private readonly maxRetries: number;
    private readonly initialBackoffMs: number;
    private readonly maxBackoffMs: number;

    constructor(cfg: GroqWhisperConfig = {}) {
        const key = cfg.apiKey ?? process.env.GROQ_API_KEY ?? '';
        if (!key) throw new Error('GROQ_API_KEY not configured');
        this.apiKey = key;
        this.model =
            cfg.model ?? process.env.GROQ_MODEL ?? 'whisper-large-v3-turbo';
        this.endpoint =
            cfg.endpoint ??
            'https://api.groq.com/openai/v1/audio/transcriptions';
        this.maxRetries = cfg.maxRetries ?? 3;
        this.initialBackoffMs = cfg.initialBackoffMs ?? 200;
        this.maxBackoffMs = cfg.maxBackoffMs ?? 2000;
    }

    async transcribe(
        filePath: string,
        opts: { timeoutMs: number; signal?: AbortSignal; languageHint?: string }
    ): Promise<AsrProviderResult> {
        const { timeoutMs, signal, languageHint } = opts;

        const controller = new AbortController();
        const signals: AbortSignal[] = [controller.signal];
        if (signal) {
            if (signal.aborted) controller.abort();
            else
                signal.addEventListener('abort', () => controller.abort(), {
                    once: true,
                });
            signals.push(signal);
        }
        const timeout = setTimeout(
            () => controller.abort(),
            Math.max(1, timeoutMs)
        );
        try {
            return await this.requestWithRetry(
                filePath,
                languageHint,
                controller.signal
            );
        } finally {
            clearTimeout(timeout);
        }
    }

    private async requestWithRetry(
        filePath: string,
        languageHint: string | undefined,
        signal: AbortSignal
    ): Promise<AsrProviderResult> {
        let attempt = 0;
        let backoff = this.initialBackoffMs;
        // Prepare payload outside of loop? File object can be reused.
        const file = await this.buildFile(filePath);
        const form = new FormData();
        form.set('model', this.model);
        form.set('response_format', 'verbose_json');
        if (languageHint && languageHint !== 'auto')
            form.set('language', languageHint);
        form.set('file', file);

        // Clone-able body for retries? FormData can be re-sent in Bun; if not, rebuild per attempt.
        const buildBody = async () => {
            // Rebuild to be safe for multiple attempts
            const f = await this.buildFile(filePath);
            const fd = new FormData();
            fd.set('model', this.model);
            fd.set('response_format', 'verbose_json');
            if (languageHint && languageHint !== 'auto')
                fd.set('language', languageHint);
            fd.set('file', f);
            return fd;
        };

        // Retry loop
        // eslint-disable-next-line no-constant-condition
        while (true) {
            try {
                const res = await fetch(this.endpoint, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                    },
                    body: attempt === 0 ? form : await buildBody(),
                    signal,
                });

                if (!res.ok) {
                    if (this.isRetryable(res.status)) {
                        attempt++;
                        if (attempt > this.maxRetries) {
                            throw new ProviderHttpError(
                                res.status,
                                await GroqWhisperProvider.safeText(res)
                            );
                        }
                        const retryAfter = this.parseRetryAfter(
                            res.headers.get('retry-after')
                        );
                        const wait = Math.min(
                            Math.max(retryAfter ?? backoff, 0),
                            this.maxBackoffMs
                        );
                        await GroqWhisperProvider.sleep(wait);
                        backoff = Math.min(backoff * 2, this.maxBackoffMs);
                        continue;
                    }
                    throw new ProviderHttpError(
                        res.status,
                        await GroqWhisperProvider.safeText(res)
                    );
                }

                const json: any = await res.json();
                return this.mapVerboseJson(json);
            } catch (err: any) {
                // Network or abort
                if (err?.name === 'AbortError') throw err;
                attempt++;
                if (attempt > this.maxRetries) {
                    if (err instanceof ProviderHttpError) throw err;
                    throw new ProviderHttpError(0, String(err?.message ?? err));
                }
                const wait = Math.min(backoff, this.maxBackoffMs);
                await GroqWhisperProvider.sleep(wait);
                backoff = Math.min(backoff * 2, this.maxBackoffMs);
            }
        }
    }

    private mapVerboseJson(json: any): AsrProviderResult {
        const segments: AsrProviderSegment[] = Array.isArray(json?.segments)
            ? json.segments.map((s: any) => ({
                  startSec: Number(s.start) || 0,
                  endSec: Number(s.end) || 0,
                  text: String(s.text ?? '')
                      .trim()
                      .replace(/\s+/g, ' '),
                  words: Array.isArray(s.words)
                      ? s.words.map((w: any) => ({
                            startSec: Number(w.start) || 0,
                            endSec: Number(w.end) || 0,
                            text: String(w.word ?? '').trim(),
                        }))
                      : undefined,
              }))
            : [];

        const durationSec = segments.length
            ? segments[segments.length - 1]!.endSec
            : 0;
        return {
            segments,
            detectedLanguage: json?.language,
            modelVersion: json?.model ?? this.model,
            durationSec,
        };
    }

    private async buildFile(filePath: string): Promise<File> {
        const bf = Bun.file(filePath);
        const ab = await bf.arrayBuffer();
        const name = filePath.split('/').pop() || 'audio';
        return new File([ab], name);
    }

    private isRetryable(status: number): boolean {
        return status === 429 || (status >= 500 && status <= 599);
    }

    private parseRetryAfter(val: string | null): number | null {
        if (!val) return null;
        const s = Number(val);
        return Number.isFinite(s) ? Math.max(0, Math.floor(s * 1000)) : null;
    }

    static async safeText(res: Response): Promise<string | undefined> {
        try {
            const t = await res.text();
            // minimal redaction (avoid echoing tokens if ever present)
            return t.replace(/(api|bearer)\s+[a-z0-9-_]+/gi, '$1 ***');
        } catch {
            return undefined;
        }
    }

    static sleep(ms: number) {
        return new Promise((r) => setTimeout(r, ms));
    }
}
```

## File: src/common/tests/common.test.js
```javascript
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
```

## File: src/common/config.ts
```typescript
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
```

## File: src/common/redact.ts
```typescript
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
```

## File: src/common/state.ts
```typescript
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
```

## File: src/contracts/index.ts
```typescript
export type {
    SourceType,
    JobStatus,
    CreateJobInput as CreateJobInputType,
    JobRecord,
} from './types';

export * as Schemas from './schemas';
export { maybeGenerateOpenApi } from './openapi';
```

## File: src/data/drizzle/meta/0000_snapshot.json
```json
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
```

## File: src/data/drizzle/meta/0002_snapshot.json
```json
{
  "id": "f9103973-8623-4ab9-8417-35fc73e53814",
  "prevId": "8b6622c6-d409-4478-942e-59689bb2473a",
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
    "public.asr_artifacts": {
      "name": "asr_artifacts",
      "schema": "",
      "columns": {
        "asr_job_id": {
          "name": "asr_job_id",
          "type": "uuid",
          "primaryKey": false,
          "notNull": true
        },
        "kind": {
          "name": "kind",
          "type": "text",
          "primaryKey": false,
          "notNull": true
        },
        "storage_key": {
          "name": "storage_key",
          "type": "text",
          "primaryKey": false,
          "notNull": true
        },
        "size_bytes": {
          "name": "size_bytes",
          "type": "integer",
          "primaryKey": false,
          "notNull": false
        },
        "created_at": {
          "name": "created_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        }
      },
      "indexes": {},
      "foreignKeys": {
        "asr_artifacts_asr_job_id_asr_jobs_id_fk": {
          "name": "asr_artifacts_asr_job_id_asr_jobs_id_fk",
          "tableFrom": "asr_artifacts",
          "tableTo": "asr_jobs",
          "columnsFrom": [
            "asr_job_id"
          ],
          "columnsTo": [
            "id"
          ],
          "onDelete": "cascade",
          "onUpdate": "no action"
        }
      },
      "compositePrimaryKeys": {
        "asr_artifacts_asr_job_id_kind_pk": {
          "name": "asr_artifacts_asr_job_id_kind_pk",
          "columns": [
            "asr_job_id",
            "kind"
          ]
        }
      },
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.asr_jobs": {
      "name": "asr_jobs",
      "schema": "",
      "columns": {
        "id": {
          "name": "id",
          "type": "uuid",
          "primaryKey": true,
          "notNull": true
        },
        "clip_job_id": {
          "name": "clip_job_id",
          "type": "uuid",
          "primaryKey": false,
          "notNull": false
        },
        "source_type": {
          "name": "source_type",
          "type": "text",
          "primaryKey": false,
          "notNull": true
        },
        "source_key": {
          "name": "source_key",
          "type": "text",
          "primaryKey": false,
          "notNull": false
        },
        "media_hash": {
          "name": "media_hash",
          "type": "text",
          "primaryKey": false,
          "notNull": true
        },
        "model_version": {
          "name": "model_version",
          "type": "text",
          "primaryKey": false,
          "notNull": true
        },
        "language_hint": {
          "name": "language_hint",
          "type": "text",
          "primaryKey": false,
          "notNull": false
        },
        "detected_language": {
          "name": "detected_language",
          "type": "text",
          "primaryKey": false,
          "notNull": false
        },
        "duration_sec": {
          "name": "duration_sec",
          "type": "integer",
          "primaryKey": false,
          "notNull": false
        },
        "status": {
          "name": "status",
          "type": "asr_job_status",
          "typeSchema": "public",
          "primaryKey": false,
          "notNull": true,
          "default": "'queued'"
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
        "completed_at": {
          "name": "completed_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": false
        },
        "expires_at": {
          "name": "expires_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": false
        }
      },
      "indexes": {
        "idx_asr_jobs_status_created_at": {
          "name": "idx_asr_jobs_status_created_at",
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
        "idx_asr_jobs_expires_at": {
          "name": "idx_asr_jobs_expires_at",
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
      "foreignKeys": {
        "asr_jobs_clip_job_id_jobs_id_fk": {
          "name": "asr_jobs_clip_job_id_jobs_id_fk",
          "tableFrom": "asr_jobs",
          "tableTo": "jobs",
          "columnsFrom": [
            "clip_job_id"
          ],
          "columnsTo": [
            "id"
          ],
          "onDelete": "no action",
          "onUpdate": "no action"
        }
      },
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
        "result_video_burned_key": {
          "name": "result_video_burned_key",
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
        },
        "last_heartbeat_at": {
          "name": "last_heartbeat_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": false
        },
        "attempt_count": {
          "name": "attempt_count",
          "type": "integer",
          "primaryKey": false,
          "notNull": true,
          "default": 0
        },
        "processing_started_at": {
          "name": "processing_started_at",
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
        },
        "idx_jobs_status_last_hb": {
          "name": "idx_jobs_status_last_hb",
          "columns": [
            {
              "expression": "status",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "last_heartbeat_at",
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
    "public.asr_job_status": {
      "name": "asr_job_status",
      "schema": "public",
      "values": [
        "queued",
        "processing",
        "done",
        "failed"
      ]
    },
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
```

## File: src/data/drizzle/0002_add_last_heartbeat.sql
```sql
-- Add last_heartbeat_at column to jobs
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "last_heartbeat_at" timestamp with time zone;
-- Index could be added later if querying stale heartbeats frequently
```

## File: src/data/drizzle/0002_happy_nomad.sql
```sql
-- Empty migration placeholder: previous generate produced objects that already exist.
-- Keeping this file to maintain incremental numbering. No-op.
```

## File: src/data/drizzle/0003_attempt_and_processing.sql
```sql
-- Migration: add attempt_count & processing_started_at + index on (status,last_heartbeat_at)
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "attempt_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "processing_started_at" timestamp with time zone;
-- Create index to accelerate stale heartbeat recovery scans
CREATE INDEX IF NOT EXISTS "idx_jobs_status_last_hb" ON "jobs" USING btree ("status","last_heartbeat_at");
```

## File: src/data/drizzle/0004_add_burned_video_key.sql
```sql
-- Add optional burned video key column to jobs
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "result_video_burned_key" text;
```

## File: src/data/scripts/admin-jobs.ts
```typescript
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
```

## File: src/data/scripts/backfill-expires.ts
```typescript
#!/usr/bin/env bun
/**
 * One-off backfill: set expires_at for jobs lacking a value.
 * Usage: bun run src/data/scripts/backfill-expires.ts
 */
import { createDb } from '../db/connection';
import { jobs } from '../db/schema';
import { isNull, eq } from 'drizzle-orm';

const RETENTION_HOURS = Number(process.env.RETENTION_HOURS || 72);

async function main() {
    const db = createDb();
    const now = Date.now();
    const rows = await db.select().from(jobs).where(isNull(jobs.expiresAt));
    let updated = 0;
    for (const r of rows) {
        const created = (r.createdAt as Date) ?? new Date();
        const expires = new Date(
            created.getTime() + RETENTION_HOURS * 3600_000
        );
        await db
            .update(jobs)
            .set({ expiresAt: expires })
            .where(eq(jobs.id, r.id));
        updated++;
    }
    console.log(JSON.stringify({ scanned: rows.length, updated }, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
```

## File: src/data/scripts/bootstrap-storage.ts
```typescript
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
```

## File: src/data/scripts/seed.ts
```typescript
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
```

## File: src/data/scripts/verify_burned_key.ts
```typescript
import { createDb } from '../db/connection';
import { sql } from 'drizzle-orm';

const db = createDb();

async function main() {
    try {
        const rows: any = await db.execute(
            sql`SELECT column_name FROM information_schema.columns WHERE table_name='jobs' AND column_name='result_video_burned_key'`
        );
        const found = Array.isArray(rows?.rows)
            ? rows.rows.length > 0
            : Array.isArray(rows)
            ? rows.length > 0
            : !!rows;
        console.log(JSON.stringify({ ok: true, columnPresent: found }));
    } catch (e) {
        console.error(JSON.stringify({ ok: false, error: String(e) }));
        process.exit(1);
    }
}

main();
```

## File: src/data/api-keys.ts
```typescript
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
```

## File: src/data/index.ts
```typescript
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
```

## File: src/data/media-io.ts
```typescript
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
```

## File: src/ffmpeg/copy-decision.ts
```typescript
import { readBoolEnv, readFloatEnv } from '@clipper/common/env';

function secToReadInterval(startSec: number): string {
    return `${startSec}%+#2`;
}

async function keyframeOffsetFromStart(
    inputPath: string,
    startSec: number,
    timeoutMs = 3000
): Promise<number | null> {
    try {
        const args = [
            'ffprobe',
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-skip_frame',
            'nokey',
            '-show_frames',
            '-print_format',
            'json',
            '-read_intervals',
            secToReadInterval(startSec),
            inputPath,
        ];
        const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'ignore' });
        const timer = setTimeout(() => {
            try {
                proc.kill();
            } catch {}
        }, timeoutMs);
        const out = await new Response(proc.stdout).text();
        clearTimeout(timer);
        await proc.exited;
        const json = JSON.parse(out || '{}');
        const frames: any[] = Array.isArray(json.frames) ? json.frames : [];
        if (!frames.length) return null;
        const f = frames[0]!;
        const t =
            (typeof f.pkt_pts_time === 'string' && Number(f.pkt_pts_time)) ||
            (typeof f.best_effort_timestamp_time === 'string' &&
                Number(f.best_effort_timestamp_time)) ||
            (typeof f.pkt_dts_time === 'string' && Number(f.pkt_dts_time)) ||
            null;
        if (t == null || !Number.isFinite(t)) return null;
        const delta = t - startSec;
        return Number.isFinite(delta) ? Math.max(delta, 0) : null;
    } catch {
        return null;
    }
}

export interface CopyDecisionInput {
    inputPath: string;
    startSec: number;
    requireKeyframe?: boolean;
    keyframeProximitySec?: number;
}

export async function shouldAttemptCopy(
    i: CopyDecisionInput
): Promise<boolean> {
    const requireKeyframe =
        i.requireKeyframe ?? readBoolEnv('REQUIRE_KEYFRAME_FOR_COPY', false);
    if (!requireKeyframe) return true;
    const prox =
        i.keyframeProximitySec ??
        readFloatEnv('KEYFRAME_PROXIMITY_SEC', 0.5) ??
        0.5;
    const delta = await keyframeOffsetFromStart(i.inputPath, i.startSec);
    if (delta == null) return false;
    return delta <= prox;
}

export const __internals__ = { keyframeOffsetFromStart };
```

## File: src/ffmpeg/probe.ts
```typescript
import { createLogger, readEnv } from '@clipper/common';

const log = createLogger((readEnv('LOG_LEVEL') as any) || 'info').with({
    mod: 'ffprobe',
});

export interface SourceProbe {
    container: string | null;
    durationSec: number | null;
    video: { codec: string; width?: number; height?: number } | null;
    audio: { codec: string; channels?: number; sampleRate?: number } | null;
}

export async function probeSource(
    inputPath: string,
    timeoutMs = 5000
): Promise<SourceProbe | null> {
    try {
        const args = [
            'ffprobe',
            '-v',
            'error',
            '-show_streams',
            '-show_format',
            '-print_format',
            'json',
            inputPath,
        ];
        const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
        const timer = setTimeout(() => {
            try {
                proc.kill();
            } catch {}
        }, timeoutMs);
        const outText = await new Response(proc.stdout).text();
        clearTimeout(timer);
        await proc.exited;
        const json = JSON.parse(outText || '{}');
        const format = json.format || {};
        const streams: any[] = Array.isArray(json.streams) ? json.streams : [];
        const v = streams.find((s) => s.codec_type === 'video');
        const a = streams.find((s) => s.codec_type === 'audio');
        const durationSec = Number(
            format.duration ?? v?.duration ?? a?.duration
        );
        const container = (format.format_name as string | undefined) || null;
        const video = v
            ? {
                  codec: String(v.codec_name || ''),
                  width: typeof v.width === 'number' ? v.width : undefined,
                  height: typeof v.height === 'number' ? v.height : undefined,
              }
            : null;
        const audio = a
            ? {
                  codec: String(a.codec_name || ''),
                  channels:
                      typeof a.channels === 'number' ? a.channels : undefined,
                  sampleRate:
                      typeof a.sample_rate === 'string'
                          ? Number(a.sample_rate)
                          : undefined,
              }
            : null;
        return {
            container,
            durationSec: Number.isFinite(durationSec) ? durationSec : null,
            video,
            audio,
        };
    } catch (e) {
        log.warn('ffprobe failed', { error: String(e) });
        return null;
    }
}
```

## File: src/ffmpeg/types.ts
```typescript
/**
 * Types for the FFmpeg clipping service.
 */
export interface ClipResult {
    /** Local filesystem path to the generated clip file (mp4). */
    localPath: string;
    /** Async iterable emitting progress percentages (0..100). */
    progress$: AsyncIterable<number>;
}

export interface ClipArgs {
    /** Source local file path (must exist and be readable). */
    input: string;
    /** Inclusive start time in seconds. */
    startSec: number;
    /** Exclusive end time in seconds (must be > startSec). */
    endSec: number;
    /** Job id for logging / namespacing temp outputs. */
    jobId: string;
}

export interface Clipper {
    /** Execute a clip operation returning path + progress stream. */
    clip(args: ClipArgs): Promise<ClipResult>;
}
```

## File: src/ffmpeg/verify.ts
```typescript
import { readBoolEnv, readFloatEnv } from '@clipper/common/env';

export interface VerifyOutputOptions {
    expectDurationSec: number;
    toleranceSec?: number; // default 0.5
    requireFastStart?: boolean; // default true for mp4
    requireVideoOrAudio?: 'video' | 'audio' | 'either'; // default 'either'
    allowedVideoCodecs?: string[]; // optional
    allowedAudioCodecs?: string[]; // optional
}

type FfprobeFormat = {
    duration?: string;
    format_name?: string;
    tags?: Record<string, string>;
};

type FfprobeStream = {
    codec_type?: 'video' | 'audio' | string;
    codec_name?: string;
};

async function runFfprobeJson(
    path: string,
    timeoutMs = 3000
): Promise<{
    format: FfprobeFormat | null;
    streams: FfprobeStream[];
} | null> {
    try {
        const args = [
            'ffprobe',
            '-v',
            'error',
            '-print_format',
            'json',
            '-show_format',
            '-show_streams',
            path,
        ];
        const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'ignore' });
        const timer = setTimeout(() => {
            try {
                proc.kill();
            } catch {}
        }, timeoutMs);
        const out = await new Response(proc.stdout).text();
        clearTimeout(timer);
        await proc.exited;
        const json = JSON.parse(out || '{}');
        const format: FfprobeFormat | null = json.format ?? null;
        const streams: FfprobeStream[] = Array.isArray(json.streams)
            ? json.streams
            : [];
        return { format, streams };
    } catch {
        return null;
    }
}

async function readHeadBytes(
    path: string,
    maxBytes: number
): Promise<Uint8Array | null> {
    try {
        const file = Bun.file(path);
        const reader = file.stream().getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (total < maxBytes) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) break;
            chunks.push(value);
            total += value.byteLength;
            if (total >= maxBytes) break;
        }
        reader.releaseLock();
        if (!chunks.length) return new Uint8Array();
        const buf = new Uint8Array(
            chunks.reduce((acc, c) => acc + c.byteLength, 0)
        );
        let offset = 0;
        for (const c of chunks) {
            buf.set(c.slice(0), offset);
            offset += c.byteLength;
        }
        return buf.subarray(0, Math.min(buf.byteLength, maxBytes));
    } catch {
        return null;
    }
}

function findAscii(buf: Uint8Array, needle: string): number {
    const n = new TextEncoder().encode(needle);
    outer: for (let i = 0; i <= buf.byteLength - n.byteLength; i++) {
        for (let j = 0; j < n.byteLength; j++) {
            if (buf[i + j] !== n[j]) continue outer;
        }
        return i;
    }
    return -1;
}

async function checkFastStart(path: string): Promise<boolean> {
    const head = await readHeadBytes(path, 2 * 1024 * 1024); // 2MB
    if (!head) return false;
    const moov = findAscii(head, 'moov');
    const mdat = findAscii(head, 'mdat');
    if (moov === -1 || mdat === -1) return false;
    return moov < mdat;
}

export interface OutputVerifierResult {
    ok: boolean;
    reason?: string;
}

export interface OutputVerifier {
    verify(
        path: string,
        opts: VerifyOutputOptions
    ): Promise<OutputVerifierResult>;
}

class DefaultOutputVerifier implements OutputVerifier {
    async verify(
        path: string,
        opts: VerifyOutputOptions
    ): Promise<OutputVerifierResult> {
        const tolerance =
            opts.toleranceSec ??
            readFloatEnv('VERIFY_TOLERANCE_SEC', 0.5) ??
            0.5;
        const requireFastStart =
            opts.requireFastStart ??
            readBoolEnv('VERIFY_REQUIRE_FASTSTART', true);
        const expectStream = opts.requireVideoOrAudio ?? 'either';

        const probe = await runFfprobeJson(path);
        if (!probe) return { ok: false, reason: 'ffprobe_failed' };
        const { format, streams } = probe;

        // Duration check
        const dur = format?.duration ? Number(format.duration) : NaN;
        if (!Number.isFinite(dur)) {
            return { ok: false, reason: 'duration_unavailable' };
        }
        if (Math.abs(dur - opts.expectDurationSec) > tolerance) {
            return {
                ok: false,
                reason: `duration_out_of_tolerance expected=${opts.expectDurationSec} actual=${dur} tol=${tolerance}`,
            };
        }

        // Streams presence
        const hasVideo = streams.some((s) => s.codec_type === 'video');
        const hasAudio = streams.some((s) => s.codec_type === 'audio');
        if (
            (expectStream === 'video' && !hasVideo) ||
            (expectStream === 'audio' && !hasAudio) ||
            (expectStream === 'either' && !hasVideo && !hasAudio)
        ) {
            return { ok: false, reason: 'required_streams_missing' };
        }

        // Codec allowlists
        if (opts.allowedVideoCodecs && hasVideo) {
            const vOk = streams
                .filter((s) => s.codec_type === 'video')
                .every((s) =>
                    s.codec_name
                        ? opts.allowedVideoCodecs!.includes(s.codec_name)
                        : false
                );
            if (!vOk) return { ok: false, reason: 'video_codec_not_allowed' };
        }
        if (opts.allowedAudioCodecs && hasAudio) {
            const aOk = streams
                .filter((s) => s.codec_type === 'audio')
                .every((s) =>
                    s.codec_name
                        ? opts.allowedAudioCodecs!.includes(s.codec_name)
                        : false
                );
            if (!aOk) return { ok: false, reason: 'audio_codec_not_allowed' };
        }

        // Faststart (only attempt for MP4 containers)
        const isMp4 =
            (format?.format_name || '').includes('mp4') ||
            (format?.format_name || '').includes('mov');
        if (requireFastStart && isMp4) {
            const fsOk = await checkFastStart(path);
            if (!fsOk) return { ok: false, reason: 'faststart_missing' };
        }

        return { ok: true };
    }
}

export const outputVerifier: OutputVerifier = new DefaultOutputVerifier();
export const __internals__ = {
    runFfprobeJson,
    checkFastStart,
    readHeadBytes,
    findAscii,
};
```

## File: src/queue/asr.ts
```typescript
import { z } from 'zod';

export const AsrQueuePayloadSchema = z.object({
    asrJobId: z.string().uuid(),
    clipJobId: z.string().uuid().optional(),
    languageHint: z.string().optional(),
});

export type AsrQueuePayload = z.infer<typeof AsrQueuePayloadSchema>;
```

## File: src/queue/index.ts
```typescript
export * from './types';
export * from './pgboss';
export * from './dlq-consumer';
```

## File: src/queue/publish.ts
```typescript
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
```

## File: src/worker/cleanup.ts
```typescript
import { readEnv } from '@clipper/common';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function measureDirSizeBytes(dir: string): Promise<number> {
    try {
        const s = await stat(dir);
        if (!s.isDirectory()) return s.size;
    } catch {
        return 0;
    }
    let total = 0;
    const stack: string[] = [dir];
    while (stack.length) {
        const d = stack.pop()!;
        let ents: any[] = [];
        try {
            ents = await readdir(d, { withFileTypes: true } as any);
        } catch {
            continue;
        }
        for (const ent of ents) {
            const p = join(d, (ent as any).name);
            try {
                if ((ent as any).isDirectory?.()) stack.push(p);
                else {
                    const s = await stat(p);
                    total += s.size;
                }
            } catch {}
        }
    }
    return total;
}

export async function removeDirRecursive(dir: string): Promise<void> {
    try {
        await rm(dir, { recursive: true, force: true } as any);
    } catch {}
}

export async function cleanupScratch(dir: string, success: boolean) {
    if (!dir) return { deleted: false, sizeBytes: 0 } as const;
    const keepOnSuccess =
        String(readEnv('KEEP_SCRATCH_ON_SUCCESS') || '0') === '1';
    const keepOnFailure = String(readEnv('KEEP_FAILED') || '0') === '1';
    if (success) {
        if (keepOnSuccess) {
            return {
                deleted: false,
                sizeBytes: await measureDirSizeBytes(dir),
            } as const;
        }
        await removeDirRecursive(dir);
        return { deleted: true, sizeBytes: 0 } as const;
    }
    if (keepOnFailure) {
        return {
            deleted: false,
            sizeBytes: await measureDirSizeBytes(dir),
        } as const;
    }
    await removeDirRecursive(dir);
    return { deleted: true, sizeBytes: 0 } as const;
}

export interface StorageLike {
    remove(key: string): Promise<void>;
}

export async function cleanupStorageOnFailure(
    storage: StorageLike | null,
    key: string | null
) {
    const keepOnFailure = String(readEnv('KEEP_FAILED') || '0') === '1';
    if (!storage || !key || keepOnFailure) return false;
    try {
        await storage.remove(key);
        return true;
    } catch {
        return false;
    }
}
```

## File: src/worker/retry.ts
```typescript
import { readEnv } from '@clipper/common';

export type RetryClass = 'retryable' | 'fatal';

export function getMaxRetries(): number {
    const max = Number(
        readEnv('MAX_RETRIES') || readEnv('JOB_MAX_ATTEMPTS') || 3
    );
    return Number.isFinite(max) && max > 0 ? Math.floor(max) : 3;
}

export function classifyError(e: unknown): RetryClass {
    const msg = String((e as any)?.message || e || '');
    // Known transient/network/storage
    if (
        /CLIP_TIMEOUT|STORAGE_NOT_AVAILABLE|storage_upload_failed|timeout|fetch|network|ECONN|EAI_AGAIN|ENOTFOUND|5\d{2}/i.test(
            msg
        )
    ) {
        return 'retryable';
    }
    // Output missing/empty -> fatal
    if (/OUTPUT_EMPTY|OUTPUT_MISSING/i.test(msg)) return 'fatal';
    // ServiceError code-based hints when available
    const code = (e as any)?.error?.code || (e as any)?.code;
    if (typeof code === 'string') {
        if (
            /VALIDATION_FAILED|OUTPUT_VERIFICATION_FAILED|SOURCE_UNREADABLE/i.test(
                code
            )
        ) {
            return 'fatal';
        }
    }
    return 'fatal';
}
```

## File: src/worker/stage.ts
```typescript
import { MetricsRegistry } from '@clipper/common/metrics';

export type StageErrorCode = 'timeout' | 'not_found' | 'network' | 'error';

function classifyError(e: any, custom?: (err: any) => string): StageErrorCode {
    try {
        if (custom) return (custom(e) as StageErrorCode) || 'error';
        const msg = String(e?.message || e || '').toLowerCase();
        if (/timeout/.test(msg)) return 'timeout';
        if (/not.?found|enoent/.test(msg)) return 'not_found';
        if (/network|econn|eai_again|enotfound/.test(msg)) return 'network';
        return 'error';
    } catch {
        return 'error';
    }
}

export interface WithStageOptions {
    classify?: (err: any) => string;
}

/**
 * Executes an async stage fn, recording latency & failures.
 * Metrics:
 *  - worker.stage_latency_ms{stage}
 *  - worker.stage_failures_total{stage,code}
 */
export async function withStage<T>(
    metrics: MetricsRegistry,
    stage: string,
    fn: () => Promise<T>,
    opts: WithStageOptions = {}
): Promise<T> {
    const start = performance.now();
    try {
        const res = await fn();
        metrics.observe('worker.stage_latency_ms', performance.now() - start, {
            stage,
        });
        return res;
    } catch (e) {
        metrics.observe('worker.stage_latency_ms', performance.now() - start, {
            stage,
        });
        const code = classifyError(e, opts.classify);
        metrics.inc('worker.stage_failures_total', 1, { stage, code });
        throw e;
    }
}

export { classifyError };
```

## File: .env.example
```
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
```

## File: .gitignore
```
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
```

## File: bunfig.toml
```toml
# Resolve import aliases at runtime for Bun
# Matches tsconfig paths: "@clipper/*" -> "src/*"
[alias]
"@clipper/*" = "./src/*"
```

## File: drizzle.config.ts
```typescript
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
```

## File: index.ts
```typescript
console.log("Hello via Bun!");
```

## File: tsconfig.json
```json
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
```

## File: src/common/env.ts
```typescript
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

export function readFloatEnv(
    key: string,
    defaultValue?: number
): number | undefined {
    const v = readEnv(key);
    if (v == null || v === '') return defaultValue;
    const n = Number(v);
    if (!Number.isFinite(n)) return defaultValue;
    return n;
}

export function readBoolEnv(key: string, defaultValue = false): boolean {
    const v = readEnv(key);
    if (v == null || v === '') return defaultValue;
    const low = v.toLowerCase();
    return low === '1' || low === 'true' || low === 'yes' || low === 'on';
}
```

## File: src/common/external.ts
```typescript
import { MetricsRegistry } from './metrics';

export interface ExternalCallOptions {
    dep: 'yt_dlp' | 'ffprobe' | 'storage' | 'asr';
    op: string; // short operation label
    classifyError?: (err: any) => string | undefined;
    timeoutMs?: number; // optional hard timeout
}

export async function withExternal<T>(
    metrics: MetricsRegistry,
    opts: ExternalCallOptions,
    fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
    const { dep, op } = opts; // keep option name for compatibility
    const service = dep; // expose as 'service' label in metrics per docs
    const start = performance.now();
    const controller = new AbortController();
    let timeout: any;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
        timeout = setTimeout(
            () => controller.abort(),
            opts.timeoutMs
        ).unref?.();
    }
    try {
        const res = await fn(controller.signal);
        metrics.inc('external.calls_total', 1, {
            service,
            op,
            outcome: 'ok',
        });
        metrics.observe('external.call_latency_ms', performance.now() - start, {
            service,
            op,
        });
        return res;
    } catch (e) {
        const code = classifyExternalError(e, opts.classifyError);
        metrics.inc('external.calls_total', 1, {
            service,
            op,
            outcome: 'err',
            code,
        });
        metrics.observe('external.call_latency_ms', performance.now() - start, {
            service,
            op,
        });
        throw e;
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

function classifyExternalError(
    e: any,
    custom?: (err: any) => string | undefined
): string {
    try {
        if (custom) {
            const c = custom(e);
            if (c) return c;
        }
        const msg = String(e?.message || e || '').toLowerCase();
        if (/timeout|etimedout|abort/.test(msg)) return 'timeout';
        if (/not.?found|enoent|404/.test(msg)) return 'not_found';
        if (/unauth|forbidden|401|403/.test(msg)) return 'auth';
        if (/network|econn|eai_again|enotfound/.test(msg)) return 'network';
        if (/too large|payload|413/.test(msg)) return 'too_large';
        return 'error';
    } catch {
        return 'error';
    }
}

export { classifyExternalError };
```

## File: src/common/logger.ts
```typescript
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
    // Apply redaction to message & structured fields
    const redactedBase = redactSecrets(base) as Record<string, unknown>;
    const redactedFields = redactSecrets(fields ?? ({} as any)) as Record<
        string,
        unknown
    >;
    // Ensure correlationId (if present) not accidentally redacted
    const correlationId =
        (fields as any)?.correlationId || (base as any)?.correlationId;
    if (correlationId) {
        redactedBase.correlationId = correlationId;
        redactedFields.correlationId = correlationId;
    }
    const line = {
        level,
        ts: new Date().toISOString(),
        msg: redactSecrets(msg),
        ...redactedBase,
        ...redactedFields,
    };
    try {
        console[level === 'debug' ? 'log' : level](JSON.stringify(line));
    } catch {
        // Fallback minimal log on serialization error
        try {
            console.error('{"level":"error","msg":"log serialization failed"}');
        } catch {}
    }
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
```

## File: src/common/resource-sampler.ts
```typescript
import { MetricsRegistry } from './metrics';
import { readEnv } from './env';

export interface ResourceSamplerOptions {
    metrics: MetricsRegistry;
    intervalMs?: number; // default 5000
    scratchDir?: string; // default from SCRATCH_DIR or /tmp/ytc
    getScratchUsage?: () => Promise<{
        usedBytes: number;
        capacityBytes?: number;
    }>; // test override
    now?: () => number; // test clock
}

/**
 * ResourceSampler periodically records process & system level metrics:
 *  - proc.memory_rss_mb (gauge)
 *  - scratch.disk_used_pct (gauge)   ( -1 when capacity unknown )
 *  - event_loop.lag_ms (histogram)
 *  - proc.open_fds (gauge)          (best-effort via lsof; -1 on failure)
 */
export class ResourceSampler {
    private readonly metrics: MetricsRegistry;
    private readonly intervalMs: number;
    private readonly scratchDir: string;
    private timer: any = null;
    private lastTick: number | null = null;
    private readonly getScratchUsage?: () => Promise<{
        usedBytes: number;
        capacityBytes?: number;
    }>;
    private readonly now: () => number;

    constructor(opts: ResourceSamplerOptions) {
        this.metrics = opts.metrics;
        this.intervalMs = Math.max(1000, opts.intervalMs ?? 5000);
        this.scratchDir = (
            opts.scratchDir ||
            readEnv('SCRATCH_DIR') ||
            '/tmp/ytc'
        ).replace(/\/$/, '');
        this.getScratchUsage = opts.getScratchUsage;
        this.now = opts.now || (() => performance.now());
    }

    start() {
        if (this.timer) return;
        this.lastTick = this.now();
        this.timer = setInterval(
            () => this.tick().catch(() => {}),
            this.intervalMs
        );
        (this.timer as any).unref?.();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    async tick() {
        const now = this.now();
        if (this.lastTick != null) {
            const expected = this.lastTick + this.intervalMs;
            let lag = now - expected;
            if (lag < 0) lag = 0;
            this.metrics.observe('event_loop.lag_ms', lag);
        }
        this.lastTick = now;
        this.sampleMemory();
        await this.sampleOpenFds();
        await this.sampleScratch();
    }

    private sampleMemory() {
        try {
            const rss = (process.memoryUsage?.().rss ?? 0) / (1024 * 1024);
            this.metrics.setGauge('proc.memory_rss_mb', Number(rss.toFixed(2)));
        } catch {}
    }

    private async sampleOpenFds() {
        try {
            const pid = process.pid?.toString?.() ?? '';
            if (!pid) return;
            // Use lsof if available; output lines include header; subtract 1
            const proc = Bun.spawn(
                [
                    'bash',
                    '-lc',
                    `command -v lsof >/dev/null 2>&1 && lsof -p ${pid} | wc -l || echo 0`,
                ],
                {
                    stdout: 'pipe',
                    stderr: 'ignore',
                }
            );
            const out = await new Response(proc.stdout).text();
            await proc.exited;
            const n = Math.max(0, (Number(out.trim()) || 0) - 1);
            this.metrics.setGauge('proc.open_fds', n);
        } catch {
            this.metrics.setGauge('proc.open_fds', -1);
        }
    }

    private async sampleScratch() {
        try {
            const usage = this.getScratchUsage
                ? await this.getScratchUsage()
                : await defaultScratchUsage(this.scratchDir);
            const { usedBytes, capacityBytes } = usage;
            if (capacityBytes && capacityBytes > 0) {
                const pct = (usedBytes / capacityBytes) * 100;
                this.metrics.setGauge(
                    'scratch.disk_used_pct',
                    Number(pct.toFixed(2))
                );
            } else {
                this.metrics.setGauge('scratch.disk_used_pct', -1);
            }
        } catch {
            this.metrics.setGauge('scratch.disk_used_pct', -1);
        }
    }
}

async function defaultScratchUsage(
    dir: string
): Promise<{ usedBytes: number; capacityBytes?: number }> {
    // Fast path: if directory doesn't exist, treat as empty
    let usedBytes = 0;
    try {
        const proc = Bun.spawn(
            ['find', dir, '-type', 'f', '-maxdepth', '4', '-printf', '%s\n'],
            { stdout: 'pipe', stderr: 'ignore' }
        );
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        usedBytes = out
            .split(/\n+/)
            .filter(Boolean)
            .reduce(
                (a, s) => (Number.isFinite(Number(s)) ? a + Number(s) : a),
                0
            );
    } catch {}
    let capacityBytes: number | undefined;
    try {
        const proc = Bun.spawn(['df', '-k', dir], {
            stdout: 'pipe',
            stderr: 'ignore',
        });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        const lines = out.trim().split(/\n+/);
        if (lines.length >= 2) {
            const second = lines[1] || '';
            const parts = second.split(/\s+/);
            if (parts.length >= 2) {
                const sizeKb = Number(parts[1]);
                if (Number.isFinite(sizeKb)) capacityBytes = sizeKb * 1024;
            }
        }
    } catch {}
    return { usedBytes, capacityBytes };
}

export function startResourceSampler(
    metrics: MetricsRegistry,
    opts: Partial<ResourceSamplerOptions> = {}
) {
    const sampler = new ResourceSampler({ metrics, ...opts });
    sampler.start();
    return sampler;
}
```

## File: src/common/time.ts
```typescript
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

export function coerceNearZeroDuration(
    startSec: number,
    endSec: number,
    opts: { minDurationSec: number; coerce: boolean }
): { startSec: number; endSec: number; coerced: boolean } {
    const duration = endSec - startSec;
    if (duration >= opts.minDurationSec) {
        return { startSec, endSec, coerced: false };
    }
    if (!opts.coerce) {
        return { startSec, endSec, coerced: false };
    }
    // Coerce by extending end time to meet min duration
    const newEnd = startSec + opts.minDurationSec;
    return { startSec, endSec: newEnd, coerced: true };
}
```

## File: src/contracts/openapi.ts
```typescript
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
```

## File: src/contracts/types.ts
```typescript
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
    resultVideoBurnedKey?: string;
    resultSrtKey?: string;
    error?: string;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
}
```

## File: src/data/db/connection.ts
```typescript
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
```

## File: src/data/drizzle/0000_tense_yellow_claw.sql
```sql
-- Wrapped enum creations in DO blocks for idempotence. If the type already
-- exists (e.g. database reused between runs), the duplicate_object exception
-- is swallowed so the migration can proceed. NOTE: This does NOT reconcile
-- differences in enum members; if you need to add new values later, create a
-- new migration using ALTER TYPE ... ADD VALUE.
DO $$ BEGIN
	CREATE TYPE "public"."job_status" AS ENUM('queued', 'processing', 'done', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."source_type" AS ENUM('upload', 'youtube');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_events" (
	"job_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
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
DO $$ BEGIN
	ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_job_events_job_id_ts" ON "job_events" USING btree ("job_id","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jobs_status_created_at" ON "jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jobs_expires_at" ON "jobs" USING btree ("expires_at");
```

## File: src/data/drizzle/0001_asr_jobs.sql
```sql
-- ASR tables migration
-- Make enum creation idempotent for local/dev reruns.
DO $$ BEGIN
    CREATE TYPE "public"."asr_job_status" AS ENUM('queued','processing','done','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "asr_jobs" (
    "id" uuid PRIMARY KEY NOT NULL,
    "clip_job_id" uuid,
    "source_type" text NOT NULL,
    "source_key" text,
    "media_hash" text NOT NULL,
    "model_version" text NOT NULL,
    "language_hint" text,
    "detected_language" text,
    "duration_sec" integer,
    "status" "asr_job_status" DEFAULT 'queued' NOT NULL,
    "error_code" text,
    "error_message" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    "completed_at" timestamp with time zone,
    "expires_at" timestamp with time zone
);
DO $$ BEGIN
    ALTER TABLE "asr_jobs" ADD CONSTRAINT "asr_jobs_clip_job_id_jobs_id_fk" FOREIGN KEY ("clip_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "idx_asr_jobs_status_created_at" ON "asr_jobs" USING btree ("status","created_at");
CREATE INDEX IF NOT EXISTS "idx_asr_jobs_expires_at" ON "asr_jobs" USING btree ("expires_at");
-- unique reuse index (partial)
CREATE UNIQUE INDEX IF NOT EXISTS "uq_asr_jobs_media_model_done" ON "asr_jobs" ("media_hash","model_version") WHERE status = 'done';

CREATE TABLE IF NOT EXISTS "asr_artifacts" (
    "asr_job_id" uuid NOT NULL,
    "kind" text NOT NULL,
    "storage_key" text NOT NULL,
    "size_bytes" integer,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT asr_artifacts_pk PRIMARY KEY ("asr_job_id","kind"),
    CONSTRAINT asr_artifacts_asr_job_id_asr_jobs_id_fk FOREIGN KEY ("asr_job_id") REFERENCES "public"."asr_jobs"("id") ON DELETE cascade ON UPDATE no action
);
```

## File: src/data/scripts/cleanup.ts
```typescript
import { cleanupExpiredJobs, cleanupExpiredAsrJobs } from '../cleanup';
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
    const clipRes = await cleanupExpiredJobs({
        dryRun: DRY_RUN,
        batchSize: BATCH,
        rateLimitDelayMs: RATE_DELAY,
        storage,
        logger,
    });
    const asrRes = await cleanupExpiredAsrJobs({
        dryRun: DRY_RUN,
        batchSize: BATCH,
        rateLimitDelayMs: RATE_DELAY,
        storage,
        logger,
    });
    logger.info('cleanup finished', { clip: clipRes, asr: asrRes } as any);
}

if (import.meta.main) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
```

## File: src/ffmpeg/index.ts
```typescript
// Public barrel for ffmpeg clipper
export * from './types';
export * from './progress';
export * from './clipper';
export * from './verify';
```

## File: src/queue/dlq-consumer.ts
```typescript
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

// If executed directly (bun src/queue/dlq-consumer.ts), start the consumer
if (import.meta.main) {
    const stop = await startDlqConsumer().catch((err) => {
        log.error('Failed to start DLQ consumer', { err: String(err) });
        process.exit(1);
    });

    const shutdown = async (signal: string) => {
        try {
            log.info('Shutting down DLQ consumer', { signal });
            await stop?.();
        } finally {
            process.exit(0);
        }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Keep process alive
    await new Promise(() => {});
}
```

## File: src/queue/types.ts
```typescript
export type QueuePriority = 'fast' | 'normal' | 'bulk';

export interface QueueMessage {
    jobId: string;
    priority?: QueuePriority;
}

export interface QueueAdapter {
    publish(msg: QueueMessage, opts?: { timeoutSec?: number }): Promise<void>;
    consume(handler: (msg: QueueMessage) => Promise<void>): Promise<void>;
    // Optional multi-topic API for subsystems (e.g., ASR)
    publishTo?(
        topic: string,
        msg: object,
        opts?: { timeoutSec?: number }
    ): Promise<void>;
    consumeFrom?(
        topic: string,
        handler: (msg: any) => Promise<void>
    ): Promise<void>;
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

// Queue topics used in the system
export const QUEUE_TOPIC_CLIPS = 'clips';
export const QUEUE_TOPIC_ASR = 'asr';
```

## File: src/worker/asr.start.ts
```typescript
import { PgBossQueueAdapter } from '@clipper/queue';
import { requireEnv, createLogger, readEnv } from '@clipper/common';
import { startAsrWorker } from './asr';

const log = createLogger((readEnv('LOG_LEVEL') as any) || 'info').with({
    mod: 'asr.start',
});

const queue = new PgBossQueueAdapter({
    connectionString: requireEnv('DATABASE_URL'),
});

log.info('ASR worker starting');
await startAsrWorker({ queue });
log.info('ASR worker started');
```

## File: scripts/submit-and-poll.ts
```typescript
#!/usr/bin/env bun
/**
 * Submit a clip job to the local API and poll until result is ready.
 * Usage:
 *  bun scripts/submit-and-poll.ts --url <youtubeUrl> --start 00:01:00 --end 00:01:45 --lang en [--burn]
 */

function parseArgs() {
    const args = new Map<string, string | boolean>();
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (!next || next.startsWith('--')) {
                args.set(key, true);
            } else {
                args.set(key, next);
                i++;
            }
        }
    }
    return args;
}

const args = parseArgs();
const youtubeUrl = String(args.get('url') || args.get('youtube') || '');
const start = String(args.get('start') || '');
const end = String(args.get('end') || '');
const lang = String(args.get('lang') || 'en');
const burn = Boolean(args.get('burn') || false);

if (!youtubeUrl || !start || !end) {
    console.error(
        'Usage: bun scripts/submit-and-poll.ts --url <youtubeUrl> --start 00:MM:SS --end 00:MM:SS --lang en [--burn]'
    );
    process.exit(2);
}

const API = process.env.API_BASE_URL || 'http://localhost:3000';

async function submitJob() {
    const payload = {
        sourceType: 'youtube',
        youtubeUrl,
        start,
        end,
        withSubtitles: true,
        subtitleLang: lang,
        burnSubtitles: burn,
    };
    const res = await fetch(`${API}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Create failed ${res.status}: ${txt}`);
    }
    const data = (await res.json()) as any;
    const id = data?.job?.id || data?.id || data?.jobId;
    if (!id) throw new Error(`No job id in response: ${JSON.stringify(data)}`);
    return id as string;
}

async function getResult(id: string) {
    const res = await fetch(`${API}/api/jobs/${id}/result`);
    if (res.status === 404) return null; // not ready
    if (!res.ok)
        throw new Error(`Result failed ${res.status}: ${await res.text()}`);
    return (await res.json()) as any;
}

async function main() {
    console.log(
        `[submit] creating job for ${youtubeUrl} from ${start} to ${end} (lang=${lang}, burn=${burn})`
    );
    const id = await submitJob();
    console.log(`[submit] job id: ${id}`);
    const startTs = Date.now();
    const timeoutMs = Number(process.env.SUBMIT_TIMEOUT_MS || 15 * 60_000);
    const pollMs = 5_000;
    while (true) {
        if (Date.now() - startTs > timeoutMs)
            throw new Error('Timed out waiting for result');
        const res = await getResult(id);
        if (res) {
            const r = res.result || res;
            console.log('\n=== Clip Ready ===');
            console.log(`Job: ${r.id || id}`);
            if (r.video?.url) console.log(`Video: ${r.video.url}`);
            if (r.burnedVideo?.url) console.log(`Burned: ${r.burnedVideo.url}`);
            if (r.srt?.url) console.log(`SRT: ${r.srt.url}`);
            return;
        }
        process.stdout.write('.');
        await new Promise((r) => setTimeout(r, pollMs));
    }
}

main().catch((e) => {
    console.error('\n[submit] error:', e?.message || e);
    process.exit(1);
});
```

## File: src/asr/facade.ts
```typescript
import { createHash } from 'crypto';
import type {
    AsrArtifactsRepository,
    AsrArtifactRow,
    AsrJobsRepository,
} from '@clipper/data';
import type { QueueAdapter } from '@clipper/queue';
import { QUEUE_TOPIC_ASR } from '@clipper/queue';
import { AsrQueuePayloadSchema } from '@clipper/queue/asr';

export interface AsrFacadeDeps {
    asrJobs: AsrJobsRepository;
    asrArtifacts?: AsrArtifactsRepository;
    queue?: QueueAdapter; // optional for now; Task 5 will formalize ASR topic
}

export interface AsrRequest {
    localPath: string; // required: scratch media file to hash & transcribe
    clipJobId?: string;
    sourceType?: string; // upload | youtube | internal (default internal)
    sourceKey?: string; // optional storage key
    modelVersion?: string; // default from env or whisper-large-v3-turbo
    languageHint?: string; // 'auto' or ISO 639-1
}

export interface AsrRequestResult {
    asrJobId: string;
    status: 'reused' | 'queued';
    artifacts?: AsrArtifactRow[];
    mediaHash: string;
    modelVersion: string;
}

export class AsrFacade {
    constructor(private readonly deps: AsrFacadeDeps) {}

    async request(req: AsrRequest): Promise<AsrRequestResult> {
        const modelVersion =
            req.modelVersion ||
            process.env.GROQ_MODEL ||
            'whisper-large-v3-turbo';
        const mediaHash = await sha256File(req.localPath);

        // Try reuse shortcut
        const reusable = await this.deps.asrJobs.getReusable(
            mediaHash,
            modelVersion
        );
        if (reusable) {
            // Even when reusing, publish a lightweight ASR task so the ASR worker
            // can attach artifacts to the clip job, perform burn-in if requested,
            // and finalize the clip job. This avoids leaving the clip "processing".
            if (this.deps.queue) {
                try {
                    const payload = {
                        asrJobId: reusable.id,
                        clipJobId: req.clipJobId,
                        languageHint: req.languageHint,
                    };
                    const parsed = AsrQueuePayloadSchema.parse(payload);
                    if (this.deps.queue.publishTo) {
                        await this.deps.queue.publishTo(
                            QUEUE_TOPIC_ASR,
                            parsed
                        );
                    } else {
                        await this.deps.queue.publish({
                            jobId: reusable.id,
                            priority: 'normal',
                        });
                    }
                } catch (e) {
                    // Non-fatal; reuse still returned, but ASR worker won't run
                }
            }
            return {
                asrJobId: reusable.id,
                status: 'reused',
                artifacts: reusable.artifacts,
                mediaHash,
                modelVersion,
            };
        }

        // Create a new ASR job row (queued)
        const id = crypto.randomUUID();
        await this.deps.asrJobs.create({
            id,
            clipJobId: req.clipJobId,
            sourceType: req.sourceType || 'internal',
            sourceKey: req.sourceKey,
            mediaHash,
            modelVersion,
            languageHint: req.languageHint,
            status: 'queued',
        });

        // Fire-and-forget enqueue (Task 5 will add dedicated ASR queue/topic)
        if (this.deps.queue) {
            try {
                const payload = {
                    asrJobId: id,
                    clipJobId: req.clipJobId,
                    languageHint: req.languageHint,
                };
                const parsed = AsrQueuePayloadSchema.parse(payload);
                if (this.deps.queue.publishTo) {
                    await this.deps.queue.publishTo(QUEUE_TOPIC_ASR, parsed);
                } else {
                    // fallback: publish to default topic if multi-topic not supported
                    await this.deps.queue.publish({
                        jobId: id,
                        priority: 'normal',
                    });
                }
            } catch (e) {
                // Non-fatal here; job remains queued for a future publisher
            }
        }

        return { asrJobId: id, status: 'queued', mediaHash, modelVersion };
    }
}

async function sha256File(filePath: string): Promise<string> {
    const hasher = createHash('sha256');
    const file = Bun.file(filePath);
    const stream = file.stream();
    for await (const chunk of stream as any) {
        hasher.update(chunk);
    }
    return hasher.digest('hex');
}
```

## File: src/common/errors.ts
```typescript
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
    | 'VALIDATION_FAILED'
    | 'SOURCE_UNREADABLE'
    | 'OUTPUT_VERIFICATION_FAILED';

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
```

## File: src/common/index.ts
```typescript
export * from './config';
export * from './logger';
export * from './errors';
export * from './time';
export * from './state';
export * from './env';
export * from './metrics';
export * from './redact';
export * from './external';
export * from './resource-sampler';
```

## File: src/contracts/schemas.ts
```typescript
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
        if (val.burnSubtitles && !val.withSubtitles) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                    'burnSubtitles requires withSubtitles=true (server-side burn-in depends on SRT)',
                path: ['burnSubtitles'],
            });
        }
        // start/end relationship basic check (detailed limits in API handler)
        try {
            const [sh, sm, ss] = val.start.split(':');
            const [eh, em, es] = val.end.split(':');
            const s = Number(sh) * 3600 + Number(sm) * 60 + Number(ss);
            const e = Number(eh) * 3600 + Number(em) * 60 + Number(es);
            if (!(s < e)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'start must be before end',
                    path: ['start'],
                });
            }
        } catch {}
    });

export const JobRecord = z.object({
    id: z.string().uuid(),
    status: JobStatus,
    progress: z.number().min(0).max(100),
    resultVideoKey: z.string().optional(),
    resultVideoBurnedKey: z.string().optional(),
    resultSrtKey: z.string().optional(),
    error: z.string().optional(),
    expiresAt: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
```

## File: src/data/drizzle/meta/_journal.json
```json
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
    },
    {
      "idx": 1,
      "version": "7",
      "when": 1754966400000,
      "tag": "0001_asr_jobs",
      "breakpoints": true
    },
    {
      "idx": 2,
      "version": "7",
      "when": 1755214150964,
      "tag": "0002_happy_nomad",
      "breakpoints": true
    }
  ]
}
```

## File: src/data/media-io-upload.ts
```typescript
import { createSupabaseStorageRepo } from './storage';
import {
    readEnv,
    readIntEnv,
    createLogger,
    noopMetrics,
    type Metrics,
    withExternal,
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

async function ffprobe(
    localPath: string,
    metrics: Metrics
): Promise<FfprobeMeta> {
    return withExternal(
        metrics as any,
        { dep: 'ffprobe', op: 'probe' },
        async () => {
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
    );
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
    const signedUrl = await withExternal(
        metrics as any,
        { dep: 'storage', op: 'sign' },
        async () => storage.sign(job.sourceKey)
    );
    await withExternal(
        metrics as any,
        { dep: 'storage', op: 'download' },
        async () => {
            await streamToFile(signedUrl, localPath, metrics, {
                jobId: job.id,
            });
            return null;
        }
    );

    // ffprobe validation
    const meta = await ffprobe(localPath, metrics);

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
```

## File: src/ffmpeg/progress.ts
```typescript
/**
 * Consumes an ffmpeg `-progress pipe:1` output stream and yields integer percentage progress values.
 *
 * Contract:
 * - Input: raw ReadableStream<Uint8Array> from ffmpeg stdout configured with `-progress pipe:1`.
 * - Emits: monotonically increasing integers 0..100 (holding at 99 until process exit) then a final 100.
 * - Zero / invalid total duration → emits 100 immediately.
 * - Near-zero total duration (< MIN_DURATION_SEC) → emits 100 immediately.
 *
 * Parsing focuses on `out_time_ms` lines; other lines are ignored.
 */
import { readFloatEnv } from '@clipper/common/env';
export async function* parseFfmpegProgress(
    stream: ReadableStream<Uint8Array>,
    totalDurationSec: number
): AsyncIterable<number> {
    const minDur = readFloatEnv('MIN_DURATION_SEC', 0.5) ?? 0.5;
    if (
        totalDurationSec <= 0 ||
        !Number.isFinite(totalDurationSec) ||
        totalDurationSec < minDur
    ) {
        // Degenerate case: emit 100 immediately
        yield 100;
        return;
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let lastPercent = -1;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
            // Format: out_time_ms=1234567
            if (line.startsWith('out_time_ms=')) {
                const msStr = line.substring('out_time_ms='.length).trim();
                const ms = Number.parseInt(msStr, 10);
                if (!Number.isNaN(ms)) {
                    const sec = ms / 1_000_000;
                    let pct = Math.floor((sec / totalDurationSec) * 100);
                    if (pct >= 100) pct = 99; // hold 100 until process exit
                    if (pct > lastPercent) {
                        lastPercent = pct;
                        yield pct;
                    }
                }
            }
        }
    }
    try {
        reader.releaseLock();
    } catch {}
    if (lastPercent < 100) yield 100;
}
```

## File: src/test/setup.ts
```typescript
// Global test setup: load env and minimal Bun polyfill for vitest environment
import 'dotenv/config';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { spawn as nodeSpawn } from 'node:child_process';

if (!(globalThis as any).Bun) {
    const BunShim: any = {
        version: '1.0.0-test',
        // env is defined as an accessor to stay in sync with process.env mutations in tests
        get env() {
            return process.env as any;
        },
        set env(v: any) {
            process.env = v;
        },
        gc: () => {},
        async write(path: string, data: any) {
            const buf =
                data instanceof Uint8Array || Buffer.isBuffer(data)
                    ? data
                    : Buffer.from(data);
            await writeFile(path, buf);
            return buf.length;
        },
        file(path: string) {
            return {
                async arrayBuffer() {
                    const buf = await readFile(path);
                    return buf.buffer.slice(
                        buf.byteOffset,
                        buf.byteOffset + buf.byteLength
                    );
                },
                async text() {
                    const buf = await readFile(path);
                    return buf.toString('utf8');
                },
                async exists() {
                    try {
                        await stat(path);
                        return true;
                    } catch {
                        return false;
                    }
                },
                stream() {
                    const fs = require('node:fs');
                    const rs = fs.createReadStream(path);
                    return new ReadableStream<Uint8Array>({
                        start(controller) {
                            rs.on('data', (chunk: any) =>
                                controller.enqueue(new Uint8Array(chunk))
                            );
                            rs.on('end', () => controller.close());
                            rs.on('error', (e: any) => controller.error(e));
                        },
                        cancel() {
                            try {
                                rs.destroy();
                            } catch {}
                        },
                    });
                },
                get size() {
                    try {
                        return require('node:fs').statSync(path).size;
                    } catch {
                        return 0;
                    }
                },
            } as any;
        },
        spawn(args: string[], opts: any = {}) {
            const proc: any = nodeSpawn(
                args[0] as string,
                args.slice(1) as string[],
                { stdio: ['ignore', 'pipe', 'pipe'] }
            );
            function toWeb(stream: any) {
                return new ReadableStream<Uint8Array>({
                    start(controller) {
                        stream.on('data', (chunk: any) =>
                            controller.enqueue(new Uint8Array(chunk))
                        );
                        stream.on('end', () => controller.close());
                        stream.on('error', (e: any) => controller.error(e));
                    },
                });
            }
            return {
                stdout: opts.stdout === 'pipe' ? toWeb(proc.stdout) : null,
                stderr: opts.stderr === 'pipe' ? toWeb(proc.stderr) : null,
                exited: new Promise<number>((resolve) =>
                    proc.on('close', (code: any) => resolve(code ?? -1))
                ),
                kill(signal: string) {
                    try {
                        proc.kill(signal as any);
                    } catch {
                        /* ignore */
                    }
                },
            } as any;
        },
    };
    (globalThis as any).Bun = BunShim;
} else {
    // Ensure version exists for libraries calling Bun.version.split
    if (!(globalThis as any).Bun.version) {
        (globalThis as any).Bun.version = '1.0.0-test';
    }
    // Ensure Bun.env stays in sync with process.env
    try {
        Object.defineProperty((globalThis as any).Bun, 'env', {
            configurable: true,
            get() {
                return process.env as any;
            },
            set(v: any) {
                process.env = v;
            },
        });
    } catch {
        // fallback assignment if defineProperty fails
        (globalThis as any).Bun.env = process.env;
    }
    // Stub gc to avoid crashes in libs referencing it
    if (typeof (globalThis as any).Bun.gc !== 'function') {
        (globalThis as any).Bun.gc = () => {};
    }
}
```

## File: src/common/metrics.ts
```typescript
// Core metrics primitives & registry
export type MetricLabels = Record<string, string | number>;

export interface MetricsSnapshot {
    counters: Record<string, number>;
    histograms: Record<string, HistogramSnapshot>;
    gauges?: Record<string, number>;
}

export interface HistogramSnapshot {
    count: number;
    sum: number;
    min: number;
    max: number;
    p50: number;
    p90: number;
    p99: number;
    buckets: { le: number; count: number }[]; // cumulative counts per bucket (incl +Inf)
}

interface RegistryOpts {
    maxLabelSetsPerMetric?: number; // cardinality guardrail
    defaultHistogramBuckets?: number[]; // ascending, excludes +Inf
}

// Internal helpers
function keyWithLabels(name: string, labels?: MetricLabels) {
    if (!labels) return name;
    const parts = Object.entries(labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
    return `${name}{${parts}}`;
}

function labelsKey(labels?: MetricLabels) {
    if (!labels) return '__no_labels__';
    return Object.entries(labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('|');
}

class Counter {
    private values = new Map<string, number>();
    constructor(
        private readonly name: string,
        private readonly maxLabelSets: number
    ) {}
    inc(by: number, labels?: MetricLabels) {
        const k = labelsKey(labels);
        if (!this.values.has(k) && this.values.size >= this.maxLabelSets)
            return; // enforce limit silently
        this.values.set(k, (this.values.get(k) ?? 0) + by);
    }
    snapshot() {
        const out: Record<string, number> = {};
        for (const [lk, v] of this.values) {
            const labelObj: MetricLabels | undefined =
                lk === '__no_labels__'
                    ? undefined
                    : Object.fromEntries(
                          lk.split('|').map((kv) => kv.split('='))
                      );
            out[keyWithLabels(this.name, labelObj)] = v;
        }
        return out;
    }
}

class Gauge {
    private values = new Map<string, number>();
    constructor(
        private readonly name: string,
        private readonly maxLabelSets: number
    ) {}
    set(value: number, labels?: MetricLabels) {
        const k = labelsKey(labels);
        if (!this.values.has(k) && this.values.size >= this.maxLabelSets)
            return;
        this.values.set(k, value);
    }
    snapshot() {
        const out: Record<string, number> = {};
        for (const [lk, v] of this.values) {
            const labelObj: MetricLabels | undefined =
                lk === '__no_labels__'
                    ? undefined
                    : Object.fromEntries(
                          lk.split('|').map((kv) => kv.split('='))
                      );
            out[keyWithLabels(this.name, labelObj)] = v;
        }
        return out;
    }
}

class Histogram {
    private labelSets = new Map<
        string,
        {
            values: number[]; // retain raw for quantiles (small scale ok)
            buckets: number[]; // cumulative counts (length = bucketBounds.length + 1)
        }
    >();
    constructor(
        private readonly name: string,
        private readonly bounds: number[], // ascending, excludes +Inf
        private readonly maxLabelSets: number
    ) {}
    observe(value: number, labels?: MetricLabels) {
        const lk = labelsKey(labels);
        let set = this.labelSets.get(lk);
        if (!set) {
            if (this.labelSets.size >= this.maxLabelSets) return; // enforce limit
            set = {
                values: [],
                buckets: new Array(this.bounds.length + 1).fill(0),
            };
            this.labelSets.set(lk, set);
        }
        set.values.push(value);
        // find bucket index
        let idx = this.bounds.findIndex((b) => value <= b);
        if (idx === -1) idx = this.bounds.length; // +Inf bucket
        for (let i = idx; i < set.buckets.length; i++) {
            // cumulative increments from bucket idx to end
            set.buckets[i] = (set.buckets[i] || 0) + 1;
        }
    }
    snapshot(): Record<string, HistogramSnapshot> {
        const out: Record<string, HistogramSnapshot> = {};
        for (const [lk, data] of this.labelSets) {
            if (!data.values.length) continue;
            const sorted = [...data.values].sort((a, b) => a - b);
            const pick = (p: number): number => {
                if (!sorted.length) return 0;
                const idx = Math.min(
                    sorted.length - 1,
                    Math.max(0, Math.floor((p / 100) * sorted.length))
                );
                return sorted[idx] ?? sorted[sorted.length - 1] ?? 0;
            };
            const labelObj: MetricLabels | undefined =
                lk === '__no_labels__'
                    ? undefined
                    : Object.fromEntries(
                          lk.split('|').map((kv) => kv.split('='))
                      );
            const buckets = this.bounds.map((b, i) => ({
                le: b,
                count: data.buckets[i] || 0,
            }));
            buckets.push({
                le: Infinity,
                count: data.buckets[data.buckets.length - 1] || 0,
            });
            out[keyWithLabels(this.name, labelObj)] = {
                count: data.values.length,
                sum: data.values.reduce((a, b) => a + b, 0),
                min: sorted[0]!,
                max: sorted[sorted.length - 1]!,
                p50: pick(50),
                p90: pick(90),
                p99: pick(99),
                buckets,
            };
        }
        return out;
    }
}

export class MetricsRegistry {
    private counters = new Map<string, Counter>();
    private histograms = new Map<string, Histogram>();
    private gauges = new Map<string, Gauge>();
    private maxLabelSetsPerMetric: number;
    private defaultHistogramBuckets: number[];
    constructor(opts: RegistryOpts = {}) {
        this.maxLabelSetsPerMetric = opts.maxLabelSetsPerMetric ?? 50;
        this.defaultHistogramBuckets = opts.defaultHistogramBuckets ?? [
            5, 10, 25, 50, 100, 250, 500, 1000,
        ];
    }
    counter(name: string) {
        let c = this.counters.get(name);
        if (!c) {
            c = new Counter(name, this.maxLabelSetsPerMetric);
            this.counters.set(name, c);
        }
        return c;
    }
    histogram(name: string, buckets?: number[]) {
        let h = this.histograms.get(name);
        if (!h) {
            h = new Histogram(
                name,
                [...(buckets ?? this.defaultHistogramBuckets)].sort(
                    (a, b) => a - b
                ),
                this.maxLabelSetsPerMetric
            );
            this.histograms.set(name, h);
        }
        return h;
    }
    gauge(name: string) {
        let g = this.gauges.get(name);
        if (!g) {
            g = new Gauge(name, this.maxLabelSetsPerMetric);
            this.gauges.set(name, g);
        }
        return g;
    }
    // Convenience pass-throughs for legacy style usage
    inc(name: string, value = 1, labels?: MetricLabels) {
        this.counter(name).inc(value, labels);
    }
    observe(name: string, value: number, labels?: MetricLabels) {
        this.histogram(name).observe(value, labels);
    }
    setGauge(name: string, value: number, labels?: MetricLabels) {
        this.gauge(name).set(value, labels);
    }
    snapshot(): MetricsSnapshot {
        const counters: Record<string, number> = {};
        for (const [, c] of this.counters)
            Object.assign(counters, c.snapshot());
        const histograms: Record<string, HistogramSnapshot> = {};
        for (const [, h] of this.histograms)
            Object.assign(histograms, h.snapshot());
        const gauges: Record<string, number> = {};
        for (const [, g] of this.gauges) Object.assign(gauges, g.snapshot());
        return { counters, histograms, gauges };
    }
}

// Backwards-compatible export used across codebase
export class InMemoryMetrics extends MetricsRegistry {}

export const noopMetrics = new (class extends MetricsRegistry {
    override inc() {}
    override observe() {}
    override setGauge() {}
    override snapshot(): MetricsSnapshot {
        return { counters: {}, histograms: {}, gauges: {} };
    }
})();

// Lightweight interface type used by higher-level modules to allow dependency injection
// Accept any implementation that matches the core surface (inc/observe/setGauge/snapshot)
export type Metrics = {
    inc(name: string, value?: number, labels?: MetricLabels): void;
    observe(name: string, value: number, labels?: MetricLabels): void;
    setGauge(name: string, value: number, labels?: MetricLabels): void;
    snapshot(): MetricsSnapshot;
};

// Route normalization helper (/:id placeholder for dynamic segments)
// Replaces UUID v4 and purely numeric path segments with :id
export function normalizeRoute(path: string) {
    const pathname = path.split('?')[0] || '/';
    return (
        (pathname || '/')
            .split('/')
            .map((seg) => {
                if (!seg) return seg; // preserve leading ''
                if (/^[0-9]+$/.test(seg)) return ':id';
                if (
                    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(
                        seg
                    )
                )
                    return ':id';
                return seg;
            })
            .join('/') || '/'
    );
}
```

## File: src/data/cleanup.ts
```typescript
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
```

## File: src/data/storage.ts
```typescript
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readEnv } from '../common/index';

export const storageKeys = {
    source: (jobId: string, ext: string) =>
        `sources/${jobId}/source.${ext.replace(/^\./, '')}`,
    resultVideo: (jobId: string) => `results/${jobId}/clip.mp4`,
    resultVideoBurned: (jobId: string) => `results/${jobId}/clip.subbed.mp4`,
    resultSrt: (jobId: string) => `results/${jobId}/clip.srt`,
    transcriptSrt: (ownerId: string) =>
        `results/${ownerId}/transcript/clip.srt`,
    transcriptText: (ownerId: string) =>
        `results/${ownerId}/transcript/clip.txt`,
    transcriptJson: (ownerId: string) =>
        `results/${ownerId}/transcript/clip.json`,
};

export interface StorageRepo {
    upload(localPath: string, key: string, contentType?: string): Promise<void>;
    sign(key: string, ttlSec?: number): Promise<string>;
    remove(key: string): Promise<void>;
    download(key: string, toPath?: string): Promise<string>; // returns local path
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

    async download(key: string, toPath?: string): Promise<string> {
        const url = await this.sign(key, 60);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`STORAGE_DOWNLOAD_FAILED: ${res.status}`);
        const ab = await res.arrayBuffer();
        const out = toPath ?? `/tmp/${key.split('/').pop() || 'asset.bin'}`;
        await Bun.write(out, new Uint8Array(ab));
        return out;
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
```

## File: src/queue/pgboss.ts
```typescript
import PgBoss from 'pg-boss';
import { readEnv, readIntEnv } from '@clipper/common';
import type { QueueAdapter, QueueMessage, QueuePriority } from './types';
import { QUEUE_TOPIC_CLIPS } from './types';

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
        this.topic =
            opts.queueName ?? readEnv('QUEUE_NAME') ?? QUEUE_TOPIC_CLIPS;
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
            readIntEnv(
                'MAX_RETRIES',
                readIntEnv('QUEUE_MAX_ATTEMPTS', this.opts.maxAttempts ?? 3)
            )
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
            readIntEnv(
                'MAX_RETRIES',
                readIntEnv('QUEUE_MAX_ATTEMPTS', this.opts.maxAttempts ?? 3)
            )
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

    /**
     * Adaptive consumption loop that only fetches jobs when capacityProvider() > 0.
     * Avoids over-claiming jobs whose work would just sit waiting on a local semaphore.
     * Optional optimization (enabled by caller explicitly using this API).
     */
    async adaptiveConsume(
        handler: (msg: QueueMessage) => Promise<void>,
        capacityProvider: () => number,
        opts?: { idleDelayMs?: number; maxBatch?: number }
    ) {
        if (!this.boss) await this.start();
        const idleDelayMs = opts?.idleDelayMs ?? 250;
        const maxConfigured = Number(
            readIntEnv('QUEUE_CONCURRENCY', this.opts.concurrency ?? 4)
        );
        const maxBatch = opts?.maxBatch ?? maxConfigured;
        // Loop forever; caller governs process lifetime.
        // We intentionally do not use boss.work here so we control fetch timing.
        // eslint-disable-next-line no-constant-condition
        while (true) {
            try {
                const cap = capacityProvider();
                if (cap <= 0) {
                    await new Promise((r) => setTimeout(r, idleDelayMs));
                    continue;
                }
                const batchSize = Math.min(cap, maxBatch);
                const jobs = await this.boss!.fetch(this.topic, {
                    batchSize,
                } as any);
                if (!jobs || jobs.length === 0) {
                    await new Promise((r) => setTimeout(r, idleDelayMs));
                    continue;
                }
                this.metrics.claims += jobs.length;
                for (const job of jobs) {
                    // Fire and forget each job; completion/failure ack individually.
                    (async () => {
                        try {
                            await handler(job.data as QueueMessage);
                            await this.boss!.complete(
                                job.name,
                                job.id,
                                (job as any).data || {}
                            );
                            this.metrics.completes++;
                        } catch (err) {
                            this.metrics.retries++;
                            this.metrics.errors++;
                            try {
                                await this.boss!.fail(
                                    job.name,
                                    job.id,
                                    (job as any).data || {}
                                );
                            } catch {}
                        }
                    })();
                }
            } catch (e) {
                this.metrics.errors++;
                // Backoff briefly on errors
                await new Promise((r) => setTimeout(r, idleDelayMs));
            }
        }
    }

    // Optional multi-topic methods (for subsystems like ASR)
    async publishTo(
        topic: string,
        msg: object,
        opts?: { timeoutSec?: number }
    ) {
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
        const retryLimit = Number(
            readIntEnv('QUEUE_MAX_ATTEMPTS', this.opts.maxAttempts ?? 3)
        );
        const dlq = `${topic}.dlq`;
        try {
            await this.boss!.createQueue(topic, {
                name: topic,
                expireInSeconds,
                retryLimit,
                deadLetter: dlq,
            });
        } catch {}
        try {
            await this.boss!.createQueue(dlq, {
                name: dlq,
                expireInSeconds: expireInSeconds * 2,
                retryLimit: 0,
            });
        } catch {}
        await this.boss!.send(topic, msg, {
            expireInSeconds,
            retryLimit,
            retryBackoff: true,
            deadLetter: dlq,
        });
        this.metrics.publishes++;
    }

    async consumeFrom(topic: string, handler: (msg: any) => Promise<void>) {
        if (!this.boss) await this.start();
        const batchSize = Number(
            readIntEnv('QUEUE_CONCURRENCY', this.opts.concurrency ?? 4)
        );
        await this.boss!.work<any>(topic, { batchSize }, async (jobs) => {
            for (const job of jobs) {
                this.metrics.claims++;
                try {
                    await handler(job.data as any);
                    this.metrics.completes++;
                } catch (err) {
                    this.metrics.retries++;
                    this.metrics.errors++;
                    throw err;
                }
            }
        });
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
```

## File: vitest.config.ts
```typescript
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
    resolve: {
        alias: {
            '@clipper/common': path.resolve(__dirname, 'src/common'),
            '@clipper/ffmpeg': path.resolve(__dirname, 'src/ffmpeg'),
            '@clipper/data': path.resolve(__dirname, 'src/data'),
            '@clipper/queue': path.resolve(__dirname, 'src/queue'),
            '@clipper/contracts': path.resolve(__dirname, 'src/contracts'),
            '@clipper/worker': path.resolve(__dirname, 'src/worker'),
            '@clipper/asr': path.resolve(__dirname, 'src/asr'),
        },
    },
    test: {
        include: ['src/**/*.test.ts', 'src/**/*.integration.test.ts'],
        // Exclude Bun-runner tests from Vitest runs
        exclude: ['src/**/*.bun.test.ts'],
        testTimeout: 60000,
        setupFiles: ['src/test/setup.ts'],
    },
});
```

## File: src/data/db/schema.ts
```typescript
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
    primaryKey,
} from 'drizzle-orm/pg-core';

// Enums
export const jobStatus = pgEnum('job_status', [
    'queued',
    'processing',
    'done',
    'failed',
]);
export const sourceType = pgEnum('source_type', ['upload', 'youtube']);
export const asrJobStatus = pgEnum('asr_job_status', [
    'queued',
    'processing',
    'done',
    'failed',
]);

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
        resultVideoBurnedKey: text('result_video_burned_key'),
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
        lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
        attemptCount: integer('attempt_count').notNull().default(0),
        processingStartedAt: timestamp('processing_started_at', {
            withTimezone: true,
        }),
    },
    (t) => [
        index('idx_jobs_status_created_at').on(t.status, t.createdAt),
        index('idx_jobs_expires_at').on(t.expiresAt),
        index('idx_jobs_status_last_hb').on(t.status, t.lastHeartbeatAt),
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

// ASR tables
export const asrJobs = pgTable(
    'asr_jobs',
    {
        id: uuid('id').primaryKey(),
        clipJobId: uuid('clip_job_id').references(() => jobs.id),
        sourceType: text('source_type').notNull(), // upload | youtube | internal
        sourceKey: text('source_key'),
        mediaHash: text('media_hash').notNull(),
        modelVersion: text('model_version').notNull(),
        languageHint: text('language_hint'),
        detectedLanguage: text('detected_language'),
        durationSec: integer('duration_sec'),
        status: asrJobStatus('status').notNull().default('queued'),
        errorCode: text('error_code'),
        errorMessage: text('error_message'),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        completedAt: timestamp('completed_at', { withTimezone: true }),
        expiresAt: timestamp('expires_at', { withTimezone: true }),
    },
    (t) => [
        index('idx_asr_jobs_status_created_at').on(t.status, t.createdAt),
        index('idx_asr_jobs_expires_at').on(t.expiresAt),
        // Unique partial index handled via raw SQL migration (media_hash, model_version) where status='done'
    ]
);

export const asrArtifacts = pgTable(
    'asr_artifacts',
    {
        asrJobId: uuid('asr_job_id')
            .notNull()
            .references(() => asrJobs.id, { onDelete: 'cascade' }),
        kind: text('kind').notNull(), // srt | text | json
        storageKey: text('storage_key').notNull(),
        sizeBytes: integer('size_bytes'),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
    },
    (t) => [primaryKey({ columns: [t.asrJobId, t.kind] })]
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobEvent = typeof jobEvents.$inferSelect;
export type NewJobEvent = typeof jobEvents.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type AsrJob = typeof asrJobs.$inferSelect;
export type NewAsrJob = typeof asrJobs.$inferInsert;
export type AsrArtifact = typeof asrArtifacts.$inferSelect;
export type NewAsrArtifact = typeof asrArtifacts.$inferInsert;
```

## File: src/data/media-io-youtube.ts
```typescript
// Clean YouTube resolver (yt-dlp) with SSRF protections, binary fallback & debug logging
import {
    readEnv,
    readIntEnv,
    createLogger,
    noopMetrics,
    type Metrics,
    withExternal,
} from '../common/index';
import type { ResolveResult as SharedResolveResult } from './media-io';
import { readdir } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';

export type ResolveJob = {
    id: string;
    sourceType: 'youtube';
    sourceUrl: string;
};
export type FfprobeMeta = {
    durationSec: number;
    sizeBytes: number;
    container?: string;
};
export type YouTubeResolveResult = SharedResolveResult;

function isPrivateIPv4(ip: string): boolean {
    if (!/^[0-9.]+$/.test(ip)) return false;
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4) return false;
    const a = parts[0];
    const b = parts[1];
    return !!(
        a === 10 ||
        (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        a === 127 ||
        (a === 169 && b === 254) ||
        a === 0
    );
}
function isPrivateIPv6(ip: string): boolean {
    const v = ip.toLowerCase();
    return (
        v === '::1' ||
        v.startsWith('fc') ||
        v.startsWith('fd') ||
        v.startsWith('fe80:') ||
        v === '::' ||
        v === '::0'
    );
}

async function assertSafeUrl(raw: string) {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new Error('SSRF_BLOCKED');
    }
    if (!/^https?:$/.test(u.protocol)) throw new Error('SSRF_BLOCKED');
    const allow = (readEnv('ALLOWLIST_HOSTS') || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    if (allow.length) {
        const host = u.hostname.toLowerCase();
        if (!allow.some((h) => host === h || host.endsWith(`.${h}`)))
            throw new Error('SSRF_BLOCKED');
    }
    try {
        const res = await lookup(u.hostname, { all: true });
        for (const { address, family } of res) {
            if (
                (family === 4 && isPrivateIPv4(address)) ||
                (family === 6 && isPrivateIPv6(address))
            )
                throw new Error('SSRF_BLOCKED');
        }
    } catch {
        throw new Error('SSRF_BLOCKED');
    }
}

async function ffprobe(
    localPath: string,
    metrics: Metrics
): Promise<FfprobeMeta> {
    return withExternal(
        metrics as any,
        { dep: 'ffprobe', op: 'probe' },
        async () => {
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
            if ((await proc.exited) !== 0) throw new Error('FFPROBE_FAILED');
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
    );
}

async function findDownloadedFile(dir: string): Promise<string | null> {
    const files = await readdir(dir).catch(() => []);
    const candidates = files.filter((f) => f.startsWith('source.'));
    if (!candidates.length) return null;
    const mp4 = candidates.find((f) => f.endsWith('.mp4'));
    return `${dir}/${mp4 ?? candidates[0]}`;
}

export async function resolveYouTubeSource(
    job: ResolveJob,
    deps: { metrics?: Metrics } = {}
): Promise<YouTubeResolveResult> {
    const logger = createLogger((readEnv('LOG_LEVEL') as any) || 'info').with({
        comp: 'mediaio',
        jobId: job.id,
    });
    const metrics = deps.metrics ?? noopMetrics;
    const SCRATCH = readEnv('SCRATCH_DIR') || '/tmp/ytc';
    const MAX_MB = readIntEnv('MAX_INPUT_MB', 1024)!;
    const MAX_DUR = readIntEnv('MAX_CLIP_INPUT_DURATION_SEC', 7200)!;
    const ENABLE = (readEnv('ENABLE_YTDLP') || 'false') === 'true';
    const DEBUG = (readEnv('YTDLP_DEBUG') || 'false').toLowerCase() === 'true';
    const BIN_OVERRIDE = readEnv('YTDLP_BIN');

    logger.info('resolving youtube to local path');
    if (!ENABLE) throw new Error('YTDLP_DISABLED');
    await assertSafeUrl(job.sourceUrl);

    const baseDir = `${SCRATCH.replace(/\/$/, '')}/sources/${job.id}`;
    await Bun.spawn(['mkdir', '-p', baseDir]).exited;
    const outTemplate = `${baseDir}/source.%(ext)s`;
    const format = readEnv('YTDLP_FORMAT') || 'bv*+ba/b';
    const ytdlpArgs = [
        '-f',
        format,
        '-o',
        outTemplate,
        '--quiet',
        '--no-progress',
        '--no-cache-dir',
        '--no-part',
        '--retries',
        '3',
        '--merge-output-format',
        'mp4',
    ];
    if (MAX_MB > 0) ytdlpArgs.push('--max-filesize', `${MAX_MB}m`);
    const sections = readEnv('YTDLP_SECTIONS');
    if (sections) {
        // Expect comma-separated list like "*00:01:00-00:02:00,*00:10:00-00:10:30"
        for (const sec of sections
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)) {
            ytdlpArgs.push('--download-sections', sec);
        }
    }
    ytdlpArgs.push(job.sourceUrl);

    const candidates = Array.from(
        new Set([
            BIN_OVERRIDE || 'yt-dlp',
            '/opt/homebrew/bin/yt-dlp',
            '/usr/local/bin/yt-dlp',
            '/usr/bin/yt-dlp',
        ])
    );
    let bin: string | undefined;
    for (const b of candidates) {
        try {
            const t = Bun.spawn([b, '--version'], {
                stdout: 'ignore',
                stderr: 'ignore',
            });
            if ((await t.exited) === 0) {
                bin = b;
                break;
            }
        } catch {}
    }
    if (!bin) throw new Error('YTDLP_NOT_FOUND');
    if (DEBUG)
        logger.info('yt-dlp starting', { bin, args: ytdlpArgs.join(' ') });

    const timeoutMs = Math.min(MAX_DUR * 1000, 15 * 60 * 1000);
    const dlStart = Date.now();
    let stderrText = '';
    let stdoutText = '';
    await withExternal(
        metrics as any,
        {
            dep: 'yt_dlp',
            op: 'download',
            timeoutMs,
            classifyError: (e) => {
                const msg = String(e?.message || e);
                if (msg === 'YTDLP_TIMEOUT') return 'timeout';
                if (msg.startsWith('YTDLP_FAILED:')) {
                    const code = msg.split(':')[1] || '1';
                    return `exit_${code}`;
                }
                if (msg === 'YTDLP_NOT_FOUND') return 'not_found';
                if (msg === 'YTDLP_DISABLED') return 'disabled';
                return undefined;
            },
        },
        async (signal) => {
            let timedOut = false;
            const proc = Bun.spawn([bin!, ...ytdlpArgs], {
                stdout: 'pipe',
                stderr: 'pipe',
                env: { PATH: (process as any).env?.PATH || '' },
            });
            const onAbort = () => {
                try {
                    proc.kill('SIGKILL');
                    timedOut = true;
                } catch {}
            };
            signal.addEventListener('abort', onAbort, { once: true });
            const stderrP = new Response(proc.stderr).text();
            const stdoutP = new Response(proc.stdout).text();
            const exitCode = await proc.exited;
            stderrText = await stderrP.catch(() => '');
            stdoutText = await stdoutP.catch(() => '');
            signal.removeEventListener('abort', onAbort);
            if (timedOut) {
                await Bun.spawn(['rm', '-rf', baseDir]).exited;
                throw new Error('YTDLP_TIMEOUT');
            }
            if (exitCode !== 0) {
                if (DEBUG)
                    logger.error('yt-dlp failed', {
                        exitCode,
                        stderr: stderrText.slice(0, 800),
                    });
                await Bun.spawn(['rm', '-rf', baseDir]).exited;
                throw new Error(`YTDLP_FAILED:${exitCode}`);
            }
            if (DEBUG)
                logger.info('yt-dlp succeeded', {
                    exitCode,
                    stderrPreview: stderrText.slice(0, 200),
                    stdoutPreview: stdoutText.slice(0, 200),
                });
            return null;
        }
    );
    metrics.observe('mediaio.ytdlp.duration_ms', Date.now() - dlStart, {
        jobId: job.id,
    });

    const localPath = await findDownloadedFile(baseDir);
    if (!localPath) {
        await Bun.spawn(['rm', '-rf', baseDir]).exited;
        throw new Error('YTDLP_FAILED');
    }

    const ffStart = Date.now();
    const meta = await ffprobe(localPath, metrics);
    metrics.observe('mediaio.ffprobe.duration_ms', Date.now() - ffStart, {
        jobId: job.id,
    });
    if (meta.durationSec > MAX_DUR || meta.sizeBytes > MAX_MB * 1024 * 1024) {
        await Bun.spawn(['rm', '-rf', baseDir]).exited;
        throw new Error('INPUT_TOO_LARGE');
    }

    const cleanup = async () => {
        await Bun.spawn(['rm', '-rf', baseDir]).exited;
    };
    metrics.observe('mediaio.resolve.duration_ms', Date.now() - dlStart, {
        jobId: job.id,
    });
    logger.info('youtube resolved', {
        durationSec: meta.durationSec,
        sizeBytes: meta.sizeBytes,
    });
    return { localPath, cleanup, meta };
}
```

## File: src/data/repo.ts
```typescript
import type { JobStatus } from '@clipper/contracts';
import { desc, eq } from 'drizzle-orm';

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
    resultVideoBurnedKey?: string;
    resultSrtKey?: string;
    errorCode?: string;
    errorMessage?: string;
    createdAt: string;
    updatedAt: string;
    expiresAt?: string;
    lastHeartbeatAt?: string;
    attemptCount?: number;
    processingStartedAt?: string;
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

// --- ASR (Automatic Speech Recognition) domain types ---
export type AsrJobStatus = 'queued' | 'processing' | 'done' | 'failed';

export interface AsrJobRow {
    id: string;
    clipJobId?: string;
    sourceType: string; // upload | youtube | internal
    sourceKey?: string;
    mediaHash: string;
    modelVersion: string;
    languageHint?: string;
    detectedLanguage?: string;
    durationSec?: number;
    status: AsrJobStatus;
    errorCode?: string;
    errorMessage?: string;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    expiresAt?: string;
}

export interface AsrArtifactRow {
    asrJobId: string;
    kind: 'srt' | 'text' | 'json';
    storageKey: string;
    sizeBytes?: number;
    createdAt: string;
}

export interface AsrJobsRepository {
    create(
        row: Omit<AsrJobRow, 'createdAt' | 'updatedAt' | 'status'> &
            Partial<Pick<AsrJobRow, 'status'>>
    ): Promise<AsrJobRow>;
    get(id: string): Promise<AsrJobRow | null>;
    getReusable(
        mediaHash: string,
        modelVersion: string
    ): Promise<(AsrJobRow & { artifacts: AsrArtifactRow[] }) | null>;
    patch(id: string, patch: Partial<AsrJobRow>): Promise<AsrJobRow>;
}

export interface AsrArtifactsRepository {
    put(artifact: AsrArtifactRow): Promise<void>;
    list(asrJobId: string): Promise<AsrArtifactRow[]>;
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
    async listRecent(jobId: string, limit = 10) {
        return this.events
            .filter((e) => e.jobId === jobId)
            .sort((a, b) => a.ts.localeCompare(b.ts))
            .slice(0, limit);
    }
    async list(jobId: string, limit = 100, offset = 0): Promise<JobEvent[]> {
        return this.events
            .filter((e) => e.jobId === jobId)
            .sort((a, b) => a.ts.localeCompare(b.ts))
            .slice(offset, offset + limit);
    }
}

// (If a DrizzleJobEventsRepo is defined elsewhere, ensure it has listRecent; placeholder below if needed.)
```

## File: src/ffmpeg/clipper.ts
```typescript
/**
 * BunClipper: performs a two-phase FFmpeg clipping strategy
 * 1) Fast path: stream copy (-c copy)
 * 2) Fallback: re-encode (libx264 + aac)
 * Exposes an AsyncIterable progress$ (0..100) for the successful attempt.
 */
import type { ClipArgs, ClipResult, Clipper } from './types';
import { parseFfmpegProgress } from './progress';
import { createLogger, readEnv } from '@clipper/common';
import { mkdir, unlink } from 'node:fs/promises';
import { ServiceError } from '@clipper/common/errors';
import { probeSource } from './probe';
import { shouldAttemptCopy } from './copy-decision.ts';
import { outputVerifier } from './verify.ts';

const log = createLogger((readEnv('LOG_LEVEL') as any) || 'info').with({
    mod: 'ffmpeg',
});

// Format seconds into HH:MM:SS.mmm (zero padded)
function fmtTs(sec: number): string {
    const sign = sec < 0 ? '-' : '';
    const s = Math.abs(sec);
    const hh = Math.floor(s / 3600)
        .toString()
        .padStart(2, '0');
    const mm = Math.floor((s % 3600) / 60)
        .toString()
        .padStart(2, '0');
    const ss = Math.floor(s % 60)
        .toString()
        .padStart(2, '0');
    const ms = Math.round((s - Math.floor(s)) * 1000)
        .toString()
        .padStart(3, '0');
    return `${sign}${hh}:${mm}:${ss}.${ms}`;
}

async function probeDuration(path: string): Promise<number | null> {
    try {
        const proc = Bun.spawn(
            [
                'ffprobe',
                '-v',
                'error',
                '-show_entries',
                'format=duration',
                '-of',
                'default=noprint_wrappers=1:nokey=1',
                path,
            ],
            { stdout: 'pipe', stderr: 'ignore' }
        );
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        const dur = Number(out.trim());
        if (!Number.isFinite(dur)) return null;
        return dur;
    } catch {
        return null;
    }
}

interface AttemptResult {
    ok: boolean;
    code: number;
    stderrSnippet?: string;
}

/**
 * BunClipper implements the Clipper interface using a two-phase strategy:
 * 1. Attempt a fast stream copy (no re-encode) for speed when keyframes align.
 * 2. On failure, fallback to a re-encode ensuring playable, accurate output.
 *
 * Progress semantics:
 * - Each attempt produces its own progress stream.
 * - For a successful copy attempt, the progress stream usually completes quickly.
 * - If fallback is required, only the fallback attempt's progress is exposed.
 */
export class BunClipper implements Clipper {
    constructor(private readonly opts: { scratchDir?: string } = {}) {}

    async clip(args: ClipArgs): Promise<ClipResult> {
        // Input validation
        if (args.startSec < 0 || args.endSec < 0) {
            throw new ServiceError(
                'VALIDATION_FAILED',
                'start/end must be >= 0'
            );
        }
        if (args.endSec <= args.startSec) {
            throw new ServiceError(
                'VALIDATION_FAILED',
                'endSec must be > startSec'
            );
        }
        const srcFile = Bun.file(args.input);
        const fileExists = await srcFile.exists();
        if (!fileExists) {
            throw new ServiceError(
                'VALIDATION_FAILED',
                'input file does not exist'
            );
        }
        // Probe source early to catch unreadable/unsupported inputs
        const probe = await probeSource(args.input, 3000);
        if (!probe) {
            throw new ServiceError(
                'SOURCE_UNREADABLE',
                'Unable to read source'
            );
        }

        const scratchBase =
            this.opts.scratchDir || readEnv('SCRATCH_DIR') || '/tmp/ytc';
        const outDir = `${scratchBase}/${args.jobId}`;
        const outPath = `${outDir}/clip.mp4`;
        await mkdir(outDir, { recursive: true });

        const totalDuration = args.endSec - args.startSec;
        const startTs = fmtTs(args.startSec);
        // ffmpeg -ss <start> -i input -to <end> where -ss before -i is fast seek; -to uses absolute timeline
        const endTs = fmtTs(args.endSec);

        const attempt = async (
            mode: 'copy' | 'reencode'
        ): Promise<{
            attempt: AttemptResult;
            progress$?: AsyncIterable<number>;
        }> => {
            const common = [
                '-hide_banner',
                '-y',
                '-progress',
                'pipe:1',
                // For accuracy we will vary placement of -ss and duration flags per mode
                '-ss',
                startTs,
                '-i',
                args.input,
                // We'll prefer -to for copy (fast seek) and switch to -t during re-encode for precision
                ...(mode === 'copy'
                    ? ['-to', endTs]
                    : ['-t', totalDuration.toString()]),
                '-movflags',
                '+faststart',
            ];
            const modeArgs =
                mode === 'copy'
                    ? ['-c', 'copy']
                    : [
                          '-c:v',
                          'libx264',
                          '-preset',
                          'veryfast',
                          '-c:a',
                          'aac',
                          '-profile:v',
                          'high',
                          '-pix_fmt',
                          'yuv420p',
                      ];
            const full = ['ffmpeg', ...common, ...modeArgs, outPath];
            const started = performance.now();
            log.debug('ffmpeg attempt start', {
                jobId: args.jobId,
                mode,
                full,
            });
            const proc = Bun.spawn(full, { stdout: 'pipe', stderr: 'pipe' });
            const stderrChunks: Uint8Array[] = [];
            const maxErrBytes = 4096;
            (async () => {
                if (!proc.stderr) return;
                for await (const chunk of proc.stderr) {
                    if (
                        stderrChunks.reduce((a, c) => a + c.byteLength, 0) <
                        maxErrBytes
                    ) {
                        stderrChunks.push(chunk);
                    }
                }
            })();
            const progress$ = proc.stdout
                ? parseFfmpegProgress(proc.stdout, totalDuration)
                : (async function* () {
                      yield 100;
                  })();
            const exitCode = await proc.exited;
            const durMs = Math.round(performance.now() - started);
            const attemptRes: AttemptResult = {
                ok: exitCode === 0,
                code: exitCode,
                stderrSnippet: !stderrChunks.length
                    ? undefined
                    : new TextDecoder().decode(
                          stderrChunks.reduce(
                              (acc, c) =>
                                  new Uint8Array([
                                      ...acc,
                                      ...new Uint8Array(c),
                                  ]),
                              new Uint8Array()
                          )
                      ),
            };
            log.debug('ffmpeg attempt done', {
                jobId: args.jobId,
                mode,
                code: exitCode,
                ms: durMs,
            });
            return { attempt: attemptRes, progress$ };
        };

        // Decide whether to attempt copy first based on keyframe proximity
        let copyAllowed = true;
        try {
            copyAllowed = await shouldAttemptCopy({
                inputPath: args.input,
                startSec: args.startSec,
            });
        } catch {}

        // Fast path attempt (conditionally)
        const copyResult = copyAllowed
            ? await attempt('copy')
            : { attempt: { ok: false, code: -1 } };
        if (copyResult.attempt.ok) {
            // Output verification gate
            const verify = await outputVerifier.verify(outPath, {
                expectDurationSec: totalDuration,
                // allow slightly higher tolerance for copy path
                toleranceSec: 1,
                requireFastStart: true,
                requireVideoOrAudio: 'either',
            });
            if (verify.ok) {
                return { localPath: outPath, progress$: copyResult.progress$! };
            } else {
                log.info(
                    'copy verification failed; re-encoding for precision',
                    {
                        jobId: args.jobId,
                        reason: verify.reason,
                    }
                );
                try {
                    await unlink(outPath);
                } catch {}
            }
        }

        // Fallback (fresh progress stream)
        log.info('stream copy failed; falling back to re-encode', {
            jobId: args.jobId,
            code: copyResult.attempt.code,
        });
        const reResult = await attempt('reencode');
        if (reResult.attempt.ok) {
            // Verify re-encoded output strictly with codec allowlists
            const verify = await outputVerifier.verify(outPath, {
                expectDurationSec: totalDuration,
                toleranceSec: 0.5,
                requireFastStart: true,
                requireVideoOrAudio: 'either',
                allowedVideoCodecs: ['h264'],
                allowedAudioCodecs: ['aac'],
            });
            if (verify.ok) {
                return { localPath: outPath, progress$: reResult.progress$! };
            } else {
                try {
                    await unlink(outPath);
                } catch {}
                throw new ServiceError(
                    'OUTPUT_VERIFICATION_FAILED',
                    verify.reason || 'verification_failed'
                );
            }
        }
        // Both failed
        const msg = `ffmpeg failed (copy code=${copyResult.attempt.code}, reencode code=${reResult.attempt.code})`;
        throw new ServiceError('BAD_REQUEST', msg); // using existing code enum; adjust if more codes added later
    }
}
```

## File: package.json
```json
{
    "name": "clipper",
    "module": "index.ts",
    "type": "module",
    "private": true,
    "scripts": {
        "test": "bunx vitest run",
        "db:generate": "bunx drizzle-kit generate --config=drizzle.config.ts",
        "db:migrate": "bunx drizzle-kit migrate --config=drizzle.config.ts",
        "db:push": "bunx drizzle-kit push --config=drizzle.config.ts",
        "dev": "bun --watch src/api/index.ts",
        "dev:worker": "bun --watch src/worker/index.ts",
        "dev:asr": "bun --watch src/worker/asr.start.ts",
        "dev:dlq": "bun --watch src/queue/dlq-consumer.ts",
        "dev:all": "bun scripts/dev-all.ts",
        "start:api": "bun src/api/index.ts",
        "start:worker": "bun src/worker/index.ts",
        "start:asr": "bun src/worker/asr.start.ts",
        "start:dlq": "bun src/queue/dlq-consumer.ts",
        "test:vitest": "bunx vitest run --exclude \"**/*.bun.test.ts\"",
        "test:bun": "bun test ./src/**/*.bun.test.ts",
        "test:all": "bun run test:vitest && bun run test:bun"
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
```

## File: src/worker/asr.ts
```typescript
import {
    DrizzleAsrJobsRepo,
    DrizzleJobsRepo,
    DrizzleAsrArtifactsRepo,
    DrizzleJobEventsRepo,
    createDb,
    storageKeys,
    createSupabaseStorageRepo,
} from '@clipper/data';
import {
    buildArtifacts,
    GroqWhisperProvider,
    ProviderHttpError,
} from '@clipper/asr';
import { InMemoryMetrics } from '@clipper/common/metrics';
import { QUEUE_TOPIC_ASR } from '@clipper/queue';
import {
    AsrQueuePayloadSchema,
    type AsrQueuePayload,
} from '@clipper/queue/asr';
import {
    createLogger,
    readEnv,
    fromException,
    withExternal,
} from '@clipper/common';
import { InMemoryJobEventsRepo } from '@clipper/data';

export interface AsrWorkerDeps {
    asrJobs?: DrizzleAsrJobsRepo;
    clipJobs?: DrizzleJobsRepo;
    artifacts?: DrizzleAsrArtifactsRepo;
    provider?: GroqWhisperProvider;
    storage?: ReturnType<typeof createSupabaseStorageRepo>;
    queue: {
        consumeFrom: (
            topic: string,
            handler: (msg: any) => Promise<void>
        ) => Promise<void>;
    };
}

const log = createLogger((readEnv('LOG_LEVEL') as any) || 'info').with({
    mod: 'asrWorker',
});

export async function startAsrWorker(deps: AsrWorkerDeps) {
    const metrics = new InMemoryMetrics();
    const asrJobs = deps?.asrJobs ?? new DrizzleAsrJobsRepo(createDb());
    const clipJobs = deps?.clipJobs ?? new DrizzleJobsRepo(createDb());
    const artifacts =
        deps?.artifacts ?? new DrizzleAsrArtifactsRepo(createDb());
    const events = (() => {
        try {
            return new DrizzleJobEventsRepo(createDb());
        } catch {
            // Fallback in tests or when DB is not configured
            return new InMemoryJobEventsRepo();
        }
    })();
    const storage =
        deps?.storage ??
        (() => {
            try {
                return createSupabaseStorageRepo();
            } catch {
                return null as any;
            }
        })();
    const timeoutMs = Number(readEnv('ASR_REQUEST_TIMEOUT_MS') || 120_000);
    const includeJson =
        (readEnv('ASR_JSON_SEGMENTS') || 'false').toLowerCase() === 'true';
    const mergeGapMs = Number(readEnv('MERGE_GAP_MS') || 150);

    await deps.queue.consumeFrom(QUEUE_TOPIC_ASR, async (msg: any) => {
        // Trace message arrival for visibility
        try {
            log.info('asr msg received', { topic: QUEUE_TOPIC_ASR, msg });
        } catch {}
        const parse = AsrQueuePayloadSchema.safeParse(msg as AsrQueuePayload);
        if (!parse.success) {
            log.warn('invalid asr payload', { issues: parse.error.issues });
            return; // drop invalid messages
        }
        const { asrJobId, clipJobId, languageHint } = parse.data;
        const startedAt = Date.now();
        let tmpLocal: string | null = null;
        try {
            // Load and claim job
            const job = await asrJobs.get(asrJobId);
            if (!job) {
                log.warn('asr job not found', { asrJobId });
                return;
            }
            const jobWasAlreadyDone = job.status === 'done';
            if (job.status === 'queued') {
                await asrJobs.patch(asrJobId, { status: 'processing' });
            }

            log.info('asr job started', {
                asrJobId,
                clipJobId,
                languageHint: languageHint || job.languageHint,
            });

            // Locate media: prefer clip resultVideoKey (needed for burn-in later)
            let inputLocal: string | null = null;
            let clip: any = null;
            if (clipJobId) {
                clip = await clipJobs.get(clipJobId);
                if (!clip?.resultVideoKey) throw new Error('NO_CLIP_RESULT');
                if (!storage) throw new Error('STORAGE_NOT_AVAILABLE');
                inputLocal = await storage.download(clip.resultVideoKey);
                tmpLocal = inputLocal;
            }

            // If ASR job already completed, reuse its artifacts; else transcribe now
            let srtKey: string | null = null;
            let res: any = null;
            if (jobWasAlreadyDone) {
                const arts = await artifacts.list(asrJobId);
                srtKey = arts.find((a) => a.kind === 'srt')?.storageKey || null;
                if (srtKey) {
                    // Verify artifact actually exists in storage; if not, force refresh
                    try {
                        const verifyPath = `/tmp/${
                            clipJobId ?? asrJobId
                        }.verify.srt`;
                        await storage.download(srtKey, verifyPath);
                    } catch {
                        try {
                            log.warn(
                                'reused srt missing in storage; forcing refresh',
                                {
                                    asrJobId,
                                    clipJobId,
                                    srtKey,
                                }
                            );
                        } catch {}
                        srtKey = null;
                    }
                }
            }

            if (!jobWasAlreadyDone || !srtKey) {
                const tr = await withExternal(
                    metrics as any,
                    {
                        dep: 'asr',
                        op: 'transcribe',
                        timeoutMs,
                        classifyError: (e) => {
                            const msg = String(e?.message || e);
                            if (msg === 'TIMEOUT' || /abort/i.test(msg))
                                return 'timeout';
                            if (msg === 'VALIDATION_FAILED')
                                return 'validation';
                            if (msg === 'UPSTREAM_FAILURE') return 'upstream';
                            if (e instanceof ProviderHttpError) {
                                if (e.status === 400) return 'validation';
                                if (e.status === 0) return 'network';
                                if (e.status >= 500) return 'upstream';
                            }
                            return undefined;
                        },
                    },
                    async (signal) => {
                        log.info('groq transcribe begin', {
                            asrJobId,
                            clipJobId,
                            timeoutMs,
                            languageHint: languageHint || job.languageHint,
                        });
                        // lazily construct provider per job to avoid crashing worker when env is missing
                        const provider =
                            deps?.provider ?? new GroqWhisperProvider();
                        try {
                            const out = await provider.transcribe(inputLocal!, {
                                timeoutMs,
                                languageHint,
                                signal,
                            });
                            try {
                                log.info('groq transcribe done', {
                                    asrJobId,
                                    clipJobId,
                                    detectedLanguage: out.detectedLanguage,
                                    durationSec: out.durationSec,
                                    model: out.modelVersion,
                                });
                            } catch {}
                            return out;
                        } catch (err: any) {
                            if (err?.name === 'AbortError')
                                throw new Error('TIMEOUT');
                            if (err instanceof ProviderHttpError) {
                                if (err.status === 0)
                                    throw new Error('UPSTREAM_FAILURE');
                                if (err.status >= 500)
                                    throw new Error('UPSTREAM_FAILURE');
                                if (err.status === 400)
                                    throw new Error('VALIDATION_FAILED');
                                throw new Error('UPSTREAM_FAILURE');
                            }
                            throw err;
                        }
                    }
                );
                res = tr;
            }

            // Build artifacts
            if (!srtKey) {
                // Build and upload fresh artifacts
                const built = buildArtifacts(res.segments, {
                    includeJson,
                    mergeGapMs,
                });
                try {
                    log.info('asr artifacts built', {
                        asrJobId,
                        clipJobId,
                        segments: res.segments?.length ?? 0,
                    });
                } catch {}

                if (!storage) throw new Error('STORAGE_NOT_AVAILABLE');
                const owner = clipJobId ?? asrJobId;
                srtKey = storageKeys.transcriptSrt(owner);
                const txtKey = storageKeys.transcriptText(owner);
                const jsonKey = includeJson
                    ? storageKeys.transcriptJson(owner)
                    : null;
                const srtPath = `/tmp/${owner}.srt`;
                const txtPath = `/tmp/${owner}.txt`;
                await Bun.write(srtPath, built.srt);
                await Bun.write(txtPath, built.text);
                await storage.upload(srtPath, srtKey, 'application/x-subrip');
                await storage.upload(
                    txtPath,
                    txtKey,
                    'text/plain; charset=utf-8'
                );
                if (includeJson && jsonKey) {
                    const jsonPath = `/tmp/${owner}.json`;
                    await Bun.write(
                        jsonPath,
                        JSON.stringify(built.json || [], null, 0)
                    );
                    await storage.upload(jsonPath, jsonKey, 'application/json');
                }
                try {
                    log.info('asr artifacts uploaded', {
                        asrJobId,
                        clipJobId,
                        srtKey,
                    });
                } catch {}
            }

            // Persist artifacts
            // Persist artifacts (only when freshly created)
            try {
                if (!jobWasAlreadyDone) {
                    await artifacts.put({
                        asrJobId,
                        kind: 'srt',
                        storageKey: srtKey!,
                        createdAt: new Date().toISOString(),
                    });
                    await artifacts.put({
                        asrJobId,
                        kind: 'text',
                        storageKey: storageKeys.transcriptText(
                            clipJobId ?? asrJobId
                        ),
                        createdAt: new Date().toISOString(),
                    });
                    if (includeJson) {
                        await artifacts.put({
                            asrJobId,
                            kind: 'json',
                            storageKey: storageKeys.transcriptJson(
                                clipJobId ?? asrJobId
                            ),
                            createdAt: new Date().toISOString(),
                        });
                    }
                }
            } catch {}

            // Finalize job if we ran transcription now
            if (!jobWasAlreadyDone && res) {
                await asrJobs.patch(asrJobId, {
                    status: 'done',
                    detectedLanguage: res.detectedLanguage,
                    durationSec: Math.round(res.durationSec),
                    completedAt: new Date().toISOString(),
                });
                metrics.observe('asr.duration_ms', Date.now() - startedAt);
                metrics.inc('asr.completed');
                try {
                    log.info('asr job completed', { asrJobId, clipJobId });
                } catch {}
            }

            // Update originating clip job with transcript key if available
            if (clipJobId) {
                try {
                    if (srtKey) {
                        await clipJobs.update(clipJobId, {
                            resultSrtKey: srtKey,
                        } as any);
                    }
                } catch {}
            }

            // Burn-in subtitles if the originating clip requested it
            if (clipJobId) {
                clip = clip ?? (await clipJobs.get(clipJobId));
                if (clip?.burnSubtitles && clip?.resultVideoKey) {
                    try {
                        const burnedKey =
                            storageKeys.resultVideoBurned(clipJobId);
                        const clipLocal = await storage.download(
                            clip.resultVideoKey
                        );
                        if (!srtKey) throw new Error('NO_SRT_FOR_BURNIN');
                        const srtLocal = await storage.download(srtKey);

                        const burnedPath = `/tmp/${clipJobId}.subbed.mp4`;

                        // Emit started event + metric
                        try {
                            await events.add({
                                jobId: clipJobId,
                                ts: new Date().toISOString(),
                                type: 'burnin:started',
                                data: { srtKey, in: clip.resultVideoKey },
                            });
                        } catch {}
                        metrics.inc('burnin.started');
                        const t0 = Date.now();

                        const burnRes = await burnInSubtitles({
                            srcVideoPath: clipLocal,
                            srtPath: srtLocal,
                            outPath: burnedPath,
                        });
                        try {
                            log.info('burn-in invoked', {
                                asrJobId,
                                clipJobId,
                                inKey: clip.resultVideoKey,
                                srtKey,
                            });
                        } catch {}
                        metrics.observe(
                            'burnin.duration_ms',
                            Math.max(0, Date.now() - t0)
                        );
                        if (!burnRes.ok) {
                            metrics.inc('burnin.failed');
                            log.warn('burn-in failed (non-fatal)', {
                                asrJobId,
                                clipJobId,
                                stderr: burnRes.stderr?.slice(0, 500),
                            });
                            try {
                                await events.add({
                                    jobId: clipJobId,
                                    ts: new Date().toISOString(),
                                    type: 'burnin:failed',
                                    data: {
                                        srtKey,
                                        in: clip.resultVideoKey,
                                        err: burnRes.stderr?.slice(0, 500),
                                    },
                                });
                            } catch {}
                        } else {
                            // Upload and persist burned key without overwriting original
                            await storage.upload(
                                burnedPath,
                                burnedKey,
                                'video/mp4'
                            );
                            await clipJobs.update(clipJobId, {
                                resultVideoBurnedKey: burnedKey,
                            } as any);
                            metrics.inc('burnin.completed');
                            try {
                                log.info('burn-in uploaded', {
                                    asrJobId,
                                    clipJobId,
                                    burnedKey,
                                });
                            } catch {}
                            try {
                                await events.add({
                                    jobId: clipJobId,
                                    ts: new Date().toISOString(),
                                    type: 'burnin:completed',
                                    data: { key: burnedKey },
                                });
                            } catch {}
                        }
                    } catch (e) {
                        log.warn('burn-in stage error (non-fatal)', {
                            asrJobId,
                            e: String(e),
                        });
                    }
                }
                // Finalize clip job as done now (after burn-in attempt or skipped),
                // so API result includes burnedVideo if available, or at least the original.
                try {
                    const refreshed = await clipJobs.get(clipJobId);
                    if (refreshed && refreshed.status !== 'done') {
                        await clipJobs.update(clipJobId, {
                            status: 'done',
                            progress: 100,
                        } as any);
                        try {
                            log.info('clip job finalized by asr', {
                                clipJobId,
                                asrJobId,
                            });
                        } catch {}
                        try {
                            await events.add({
                                jobId: clipJobId,
                                ts: new Date().toISOString(),
                                type: 'done',
                                data: {},
                            });
                        } catch {}
                    }
                } catch {}
            }
        } catch (e) {
            const err = fromException(e, asrJobId);
            log.error('asr job failed', { asrJobId, err });
            metrics.inc('asr.failures');
            try {
                await asrJobs.patch(asrJobId, {
                    status: 'failed',
                    errorCode:
                        (err.error && (err.error as any).code) || 'INTERNAL',
                    errorMessage:
                        (err.error && (err.error as any).message) || String(e),
                });
            } catch {}
            // Non-fatal to main clip: finalize clip job as done so API can return original even if ASR failed
            try {
                if (clipJobId) {
                    const cur = await clipJobs.get(clipJobId);
                    if (cur && cur.status !== 'done') {
                        await clipJobs.update(clipJobId, {
                            status: 'done',
                            progress: 100,
                        } as any);
                        try {
                            log.warn(
                                'asr failed; clip finalized without subtitles',
                                {
                                    clipJobId,
                                    asrJobId,
                                }
                            );
                        } catch {}
                        try {
                            await events.add({
                                jobId: clipJobId,
                                ts: new Date().toISOString(),
                                type: 'asr:failed',
                                data: { err: String(e) },
                            });
                        } catch {}
                    }
                }
            } catch {}
            throw e; // let PgBoss retry
        } finally {
            try {
                if (tmpLocal) await Bun.spawn(['rm', '-f', tmpLocal]).exited;
            } catch {}
        }
    });
}

// --- Internal helpers ---

function escapeForSubtitlesFilter(path: string): string {
    return path
        .replace(/\\/g, '\\\\')
        .replace(/:/g, '\\:')
        .replace(/'/g, "\\'")
        .replace(/,/g, '\\,')
        .replace(/ /g, '\\ ');
}

async function burnInSubtitles(args: {
    srcVideoPath: string;
    srtPath: string;
    outPath: string;
    ffmpegBin?: string;
}): Promise<{ ok: true } | { ok: false; stderr?: string }> {
    const escapedSrt = escapeForSubtitlesFilter(args.srtPath);
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
    let stderr = '';
    try {
        if (proc.stderr) {
            for await (const c of proc.stderr) {
                stderr += new TextDecoder().decode(c);
                if (stderr.length > 4000) {
                    stderr = stderr.slice(-4000);
                }
            }
        }
    } catch {}
    const code = await proc.exited;
    if (code === 0) return { ok: true };
    return { ok: false, stderr };
}

// Export test hooks without polluting public API
export const __test = {
    escapeForSubtitlesFilter,
    burnInSubtitles,
};
```

## File: src/data/db/repos.ts
```typescript
import { desc, eq, and } from 'drizzle-orm';
import { createDb } from './connection';
import { jobEvents, jobs, asrJobs, asrArtifacts } from './schema';
import type { JobStatus } from '@clipper/contracts';
import { createLogger, noopMetrics, MetricsRegistry } from '../../common/index';
import type {
    JobEvent as RepoJobEvent,
    JobRow,
    JobEventsRepository,
    JobsRepository,
} from '../repo';
import type {
    AsrJobRow,
    AsrArtifactRow,
    AsrJobsRepository,
    AsrArtifactsRepository,
} from '../repo';

export class DrizzleJobsRepo implements JobsRepository {
    private readonly logger = createLogger('info').with({ comp: 'jobsRepo' });
    constructor(
        private readonly db = createDb(),
        private readonly metrics: MetricsRegistry = noopMetrics
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
                resultVideoBurnedKey: row.resultVideoBurnedKey,
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
        // Job lifecycle metric (Req 3.1)
        try {
            (this.metrics as any).inc?.('jobs.created_total');
        } catch {}
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
        // Fetch current status for transition metric & latency
        let current: any = null;
        try {
            const [cur] = await this.db
                .select({
                    id: jobs.id,
                    status: jobs.status,
                    createdAt: jobs.createdAt,
                })
                .from(jobs)
                .where(eq(jobs.id, id))
                .limit(1);
            current = cur;
        } catch {}
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
        // Status transition metric (Req 3.2)
        try {
            if (current && patch.status && patch.status !== current.status) {
                (this.metrics as any).inc?.('jobs.status_transition_total', 1, {
                    from: current.status,
                    to: patch.status,
                });
                // Total latency on terminal states (Req 3.3)
                if (
                    (patch.status === 'done' || patch.status === 'failed') &&
                    current.createdAt
                ) {
                    const createdAt = new Date(
                        current.createdAt as any
                    ).getTime();
                    const latency = Date.now() - createdAt;
                    (this.metrics as any).observe?.(
                        'jobs.total_latency_ms',
                        latency
                    );
                }
            }
        } catch {}
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
        private readonly metrics: MetricsRegistry = noopMetrics
    ) {}

    async add(evt: RepoJobEvent): Promise<void> {
        const start = Date.now();
        try {
            await this.db.insert(jobEvents).values({
                jobId: evt.jobId,
                ts: new Date(evt.ts),
                type: evt.type,
                data: evt.data ?? null,
            });
        } catch (e) {
            // Increment persistence failure metric (Req 8.1)
            try {
                (this.metrics as any).inc?.('events.persist_failures_total');
            } catch {}
            throw e;
        } finally {
            this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
                op: 'events.add',
            });
        }
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

// ASR Repositories
export class DrizzleAsrJobsRepo implements AsrJobsRepository {
    private readonly logger = createLogger('info').with({
        comp: 'asrJobsRepo',
    });
    constructor(
        private readonly db = createDb(),
        private readonly metrics: MetricsRegistry = noopMetrics
    ) {}

    async create(
        row: Omit<AsrJobRow, 'createdAt' | 'updatedAt' | 'status'> &
            Partial<Pick<AsrJobRow, 'status'>>
    ): Promise<AsrJobRow> {
        const start = Date.now();
        const [rec] = await this.db
            .insert(asrJobs)
            .values({
                id: row.id,
                clipJobId: row.clipJobId,
                sourceType: row.sourceType,
                sourceKey: row.sourceKey,
                mediaHash: row.mediaHash,
                modelVersion: row.modelVersion,
                languageHint: row.languageHint,
                detectedLanguage: row.detectedLanguage,
                durationSec: row.durationSec,
                status: row.status ?? 'queued',
                errorCode: row.errorCode,
                errorMessage: row.errorMessage,
                completedAt: row.completedAt ? new Date(row.completedAt) : null,
                expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
            })
            .returning();
        const out = toAsrJobRow(rec);
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'asrJobs.create',
        });
        this.logger.info('asr job created', { asrJobId: out.id });
        return out;
    }

    async get(id: string): Promise<AsrJobRow | null> {
        const start = Date.now();
        const [rec] = await this.db
            .select()
            .from(asrJobs)
            .where(eq(asrJobs.id, id))
            .limit(1);
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'asrJobs.get',
        });
        return rec ? toAsrJobRow(rec) : null;
    }

    async getReusable(
        mediaHash: string,
        modelVersion: string
    ): Promise<(AsrJobRow & { artifacts: AsrArtifactRow[] }) | null> {
        const start = Date.now();
        const [rec] = await this.db
            .select()
            .from(asrJobs)
            .where(
                and(
                    eq(asrJobs.mediaHash, mediaHash),
                    eq(asrJobs.modelVersion, modelVersion),
                    eq(asrJobs.status, 'done')
                )
            )
            .limit(1);
        if (!rec) return null;
        const artifacts = await this.db
            .select()
            .from(asrArtifacts)
            .where(eq(asrArtifacts.asrJobId, rec.id));
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'asrJobs.getReusable',
        });
        return {
            ...toAsrJobRow(rec),
            artifacts: artifacts.map(toAsrArtifactRow),
        };
    }

    async patch(id: string, patch: Partial<AsrJobRow>): Promise<AsrJobRow> {
        const start = Date.now();
        const [rec] = await this.db
            .update(asrJobs)
            .set(toAsrJobsPatch(patch))
            .where(eq(asrJobs.id, id))
            .returning();
        if (!rec) throw new Error('NOT_FOUND');
        const row = toAsrJobRow(rec);
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'asrJobs.patch',
        });
        this.logger.info('asr job patched', { asrJobId: row.id });
        return row;
    }
}

export class DrizzleAsrArtifactsRepo implements AsrArtifactsRepository {
    constructor(
        private readonly db = createDb(),
        private readonly metrics: MetricsRegistry = noopMetrics
    ) {}

    async put(artifact: AsrArtifactRow): Promise<void> {
        const start = Date.now();
        await this.db
            .insert(asrArtifacts)
            .values({
                asrJobId: artifact.asrJobId,
                kind: artifact.kind,
                storageKey: artifact.storageKey,
                sizeBytes: artifact.sizeBytes,
            })
            .onConflictDoUpdate({
                target: [asrArtifacts.asrJobId, asrArtifacts.kind],
                set: {
                    storageKey: artifact.storageKey,
                    sizeBytes: artifact.sizeBytes,
                },
            });
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'asrArtifacts.put',
        });
    }

    async list(asrJobId: string): Promise<AsrArtifactRow[]> {
        const start = Date.now();
        const rows = await this.db
            .select()
            .from(asrArtifacts)
            .where(eq(asrArtifacts.asrJobId, asrJobId));
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'asrArtifacts.list',
        });
        return rows.map(toAsrArtifactRow);
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
        resultVideoBurnedKey: j.resultVideoBurnedKey ?? undefined,
        resultSrtKey: j.resultSrtKey ?? undefined,
        errorCode: j.errorCode ?? undefined,
        errorMessage: j.errorMessage ?? undefined,
        createdAt: j.createdAt.toISOString(),
        updatedAt: j.updatedAt.toISOString(),
        expiresAt: j.expiresAt ? j.expiresAt.toISOString() : undefined,
        lastHeartbeatAt: j.lastHeartbeatAt
            ? j.lastHeartbeatAt.toISOString()
            : undefined,
        attemptCount:
            typeof j.attemptCount === 'number' ? j.attemptCount : undefined,
        processingStartedAt: j.processingStartedAt
            ? j.processingStartedAt.toISOString()
            : undefined,
    };
}

function toJobsPatch(patch: Partial<JobRow>) {
    const out: any = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (k === 'expiresAt' && v) out[k] = new Date(v as string);
        else if (k === 'lastHeartbeatAt' && v) out[k] = new Date(v as string);
        else if (k === 'processingStartedAt' && v)
            out[k] = new Date(v as string);
        else out[k] = v as any;
    }
    return out;
}

function toAsrJobRow(j: any): AsrJobRow {
    return {
        id: j.id,
        clipJobId: j.clipJobId ?? undefined,
        sourceType: j.sourceType,
        sourceKey: j.sourceKey ?? undefined,
        mediaHash: j.mediaHash,
        modelVersion: j.modelVersion,
        languageHint: j.languageHint ?? undefined,
        detectedLanguage: j.detectedLanguage ?? undefined,
        durationSec: j.durationSec ?? undefined,
        status: j.status,
        errorCode: j.errorCode ?? undefined,
        errorMessage: j.errorMessage ?? undefined,
        createdAt: j.createdAt.toISOString(),
        updatedAt: j.updatedAt.toISOString(),
        completedAt: j.completedAt ? j.completedAt.toISOString() : undefined,
        expiresAt: j.expiresAt ? j.expiresAt.toISOString() : undefined,
    };
}

function toAsrJobsPatch(patch: Partial<AsrJobRow>) {
    const out: any = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (k.endsWith('At') && v) out[k] = new Date(v as string);
        else out[k] = v as any;
    }
    return out;
}

function toAsrArtifactRow(a: any): AsrArtifactRow {
    return {
        asrJobId: a.asrJobId,
        kind: a.kind,
        storageKey: a.storageKey,
        sizeBytes: a.sizeBytes ?? undefined,
        createdAt: a.createdAt.toISOString(),
    };
}
```

## File: src/api/index.ts
```typescript
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
```

## File: src/worker/index.ts
```typescript
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
            await (sharedDb as any)
                .update(jobsTable)
                .set({ lastHeartbeatAt: now })
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
        const cid = correlationId || jobId;
        const maxMs = Number(readEnv('CLIP_MAX_RUNTIME_SEC') || 600) * 1000;
        const nowIso = () => new Date().toISOString();
        let cleanup: (() => Promise<void>) | null = null;
        let outputLocal: string | null = null;
        let scratchDir: string | null = null;
        let success = false;

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
```
