import { test, expect } from 'bun:test';
import { GroqWhisperProvider, buildArtifacts } from '@clipper/asr';
import { __test as asrTest } from '@clipper/worker/asr';

// E2E-ish test that exercises:
// 1) Downloading a YouTube video (yt-dlp)
// 2) Clipping a 45s segment with ffmpeg
// 3) Transcribing with Groq Whisper provider
// 4) Building SRT
// 5) Burning subtitles into the clip with ffmpeg
// 6) Saving outputs in ./videos for manual inspection

const YT_URL = 'https://www.youtube.com/watch?v=dXn2w_57M9E';
const START = '00:01:00';
const END = '00:01:45'; // 45 seconds

async function findCmd(cmd: string): Promise<string | null> {
    // First try shell resolution to mirror interactive shells
    try {
        const p = Bun.spawn(['/bin/sh', '-lc', `command -v ${cmd}`], {
            stdout: 'pipe',
            stderr: 'ignore',
        });
        const out = p.stdout ? await new Response(p.stdout).text() : '';
        const code = await p.exited;
        const bin = out.trim();
        if (code === 0 && bin) return bin;
    } catch {}
    // Fallback: attempt direct exec
    try {
        const p = Bun.spawn([cmd, '--version'], {
            stdout: 'ignore',
            stderr: 'ignore',
        });
        const code = await p.exited;
        if (code === 0) return cmd;
    } catch {}
    // Then try common macOS/Homebrew/system locations
    const candidates = [
        `/opt/homebrew/bin/${cmd}`,
        `/usr/local/bin/${cmd}`,
        `/usr/bin/${cmd}`,
        `/bin/${cmd}`,
    ];
    for (const c of candidates) {
        try {
            const exists = await Bun.file(c).exists();
            if (!exists) continue;
            const p = Bun.spawn([c, '--version'], {
                stdout: 'ignore',
                stderr: 'ignore',
            });
            const code = await p.exited;
            if (code === 0) return c;
        } catch {}
    }
    return null;
}

async function ensureDir(dir: string) {
    try {
        await Bun.spawn(['mkdir', '-p', dir]).exited;
    } catch {}
}

function ts() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

test('YouTube -> Groq -> SRT -> Burn-in (saves to ./videos)', async () => {
    // Preconditions
    const ffmpegBin = await findCmd('ffmpeg');
    const ytdlpBin = await findCmd('yt-dlp');
    const apiKey = process.env.GROQ_API_KEY;
    if (!ffmpegBin)
        throw new Error(
            `Missing ffmpeg. Install it (e.g., brew install ffmpeg). PATH=${process.env.PATH}`
        );
    if (!ytdlpBin)
        throw new Error(
            `Missing yt-dlp. Install it (e.g., brew install yt-dlp). PATH=${process.env.PATH}`
        );
    if (!apiKey)
        throw new Error('Missing GROQ_API_KEY env var for Groq transcription.');

    const videosDir = `${process.cwd()}/videos`;
    await ensureDir(videosDir);

    // 1) Download source via yt-dlp
    const tmpBase = `/tmp/ytc-test-${crypto.randomUUID()}`;
    const outTmpl = `${tmpBase}.%(ext)s`;
    const dl = Bun.spawn([
        ytdlpBin,
        '-f',
        'bv*+ba/b',
        '-o',
        outTmpl,
        '--quiet',
        '--no-progress',
        '--no-cache-dir',
        '--no-part',
        '--retries',
        '3',
        '--merge-output-format',
        'mp4',
        YT_URL,
    ]);
    const dlCode = await dl.exited;
    expect(dlCode).toBe(0);
    const srcPath = `${tmpBase}.mp4`;
    // Sanity
    const srcStat = await Bun.file(srcPath).exists();
    expect(srcStat).toBe(true);

    // 2) Clip the requested range; use re-encode for accuracy
    const clipPath = `${tmpBase}-clip.mp4`;
    const clip = Bun.spawn([
        ffmpegBin,
        '-y',
        '-ss',
        START,
        '-to',
        END,
        '-i',
        srcPath,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        clipPath,
    ]);
    const clipCode = await clip.exited;
    expect(clipCode).toBe(0);
    const clipExists = await Bun.file(clipPath).exists();
    expect(clipExists).toBe(true);

    // 3) Transcribe with Groq
    const provider = new GroqWhisperProvider({ apiKey });
    const timeoutMs = 180_000; // 3 minutes
    const res = await provider.transcribe(clipPath, {
        timeoutMs,
        languageHint: 'en',
    });
    expect(Array.isArray(res.segments)).toBe(true);
    expect(res.segments.length).toBeGreaterThan(0);

    // 4) Build SRT and save
    const built = buildArtifacts(res.segments, {
        includeJson: false,
        mergeGapMs: 150,
    });
    const baseName = `yt-subtitles-${ts()}`;
    const srtPath = `${videosDir}/${baseName}.srt`;
    await Bun.write(srtPath, built.srt);
    const srtExists = await Bun.file(srtPath).exists();
    expect(srtExists).toBe(true);

    // 5) Burn subtitles into the clip
    const burnedPath = `${videosDir}/${baseName}.burned.mp4`;
    const burn = await asrTest.burnInSubtitles({
        srcVideoPath: clipPath,
        srtPath,
        outPath: burnedPath,
        ffmpegBin,
    });
    expect(burn.ok).toBe(true);
    const burnedExists = await Bun.file(burnedPath).exists();
    expect(burnedExists).toBe(true);

    // 6) Save the clipped original too for reference
    const savedClip = `${videosDir}/${baseName}.clip.mp4`;
    try {
        await Bun.spawn(['cp', clipPath, savedClip]).exited;
    } catch {}
    const savedClipExists = await Bun.file(savedClip).exists();
    expect(savedClipExists).toBe(true);

    // Optional: minimal size sanity checks
    const burnedSize = (await Bun.file(burnedPath).arrayBuffer()).byteLength;
    const srtSize = (await Bun.file(srtPath).arrayBuffer()).byteLength;
    expect(burnedSize).toBeGreaterThan(0);
    expect(srtSize).toBeGreaterThan(0);

    console.log('\nSaved outputs:');
    console.log(`SRT: ${srtPath}`);
    console.log(`Burned: ${burnedPath}`);
    console.log(`Clip: ${savedClip}`);
}, 600_000);
