/**
 * BunClipper: performs a two-phase FFmpeg clipping strategy
 * 1) Fast path: stream copy (-c copy)
 * 2) Fallback: re-encode (libx264 + aac)
 * Exposes an AsyncIterable progress$ (0..100) for the successful attempt.
 */
import type { ClipArgs, ClipResult, Clipper } from './types';
import { parseFfmpegProgress } from './progress';
import { createLogger, readEnv } from '@clipper/common';
import { mkdir } from 'node:fs/promises';
import { ServiceError } from '@clipper/common/errors';
import { probeSource } from './probe';
import { shouldAttemptCopy } from './copy-decision.ts';

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
        // Bun.file(...).size will throw if not exists; so optionally check via try/catch
        let fileExists = false;
        try {
            // @ts-ignore size triggers stat
            await srcFile.arrayBuffer(); // minimal read (will allocate). If large file this is heavy; prefer stat when Bun exposes. For now just check existence via stream open.
            fileExists = true;
        } catch {
            fileExists = false;
        }
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
            // Validate duration accuracy; tolerate +/- 1s drift; if larger drift fallback to precise re-encode
            const observed = await probeDuration(outPath);
            if (
                observed != null &&
                (observed > totalDuration + 1 || observed < totalDuration - 1)
            ) {
                log.info(
                    'copy duration inaccurate; re-encoding for precision',
                    {
                        jobId: args.jobId,
                        expected: totalDuration,
                        observed,
                    }
                );
            } else {
                return { localPath: outPath, progress$: copyResult.progress$! };
            }
        }

        // Fallback (fresh progress stream)
        log.info('stream copy failed; falling back to re-encode', {
            jobId: args.jobId,
            code: copyResult.attempt.code,
        });
        const reResult = await attempt('reencode');
        if (reResult.attempt.ok) {
            return { localPath: outPath, progress$: reResult.progress$! };
        }
        // Both failed
        const msg = `ffmpeg failed (copy code=${copyResult.attempt.code}, reencode code=${reResult.attempt.code})`;
        throw new ServiceError('BAD_REQUEST', msg); // using existing code enum; adjust if more codes added later
    }
}
