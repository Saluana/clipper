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
