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
