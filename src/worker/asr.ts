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
