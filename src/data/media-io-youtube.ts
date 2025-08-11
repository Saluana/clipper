import {
    readEnv,
    readIntEnv,
    createLogger,
    noopMetrics,
    type Metrics,
} from '@clipper/common';
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
