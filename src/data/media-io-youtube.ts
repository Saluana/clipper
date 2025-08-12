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
