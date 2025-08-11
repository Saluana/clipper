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
