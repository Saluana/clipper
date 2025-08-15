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
