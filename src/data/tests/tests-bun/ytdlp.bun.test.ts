import { describe, it, expect } from 'vitest';
import { readdir } from 'node:fs/promises';

const URL = 'https://www.youtube.com/watch?v=8tx2viHpgA8';
const VIDEO_ID = '8tx2viHpgA8';

async function ensureDir(dir: string) {
    const p = Bun.spawn(['mkdir', '-p', dir]);
    const code = await p.exited;
    if (code !== 0) throw new Error('MKDIR_FAILED');
}

async function findById(dir: string, id: string): Promise<string | null> {
    const files = await readdir(dir).catch(() => []);
    const match = files.find((f) => f.startsWith(id + '.'));
    return match ? `${dir}/${match}` : null;
}

describe('yt-dlp download (integration, requires ENABLE_YTDLP=true)', () => {
    it('downloads the target video into /videos folder', async () => {
        if (process.env.ENABLE_YTDLP !== 'true') {
            console.warn('[SKIP] ENABLE_YTDLP is not true');
            return;
        }
        const videosDir = `${process.cwd()}/videos`;
        await ensureDir(videosDir);

        const outTemplate = `${videosDir}/%(id)s.%(ext)s`;
        const args = [
            '-f',
            'bv*+ba/b',
            '-o',
            outTemplate,
            '--no-progress',
            '--no-cache-dir',
            '--no-part',
            '--retries',
            '3',
            URL,
        ];

        const proc = Bun.spawn(['yt-dlp', ...args], {
            stdout: 'pipe',
            stderr: 'pipe',
        });

        const timeoutMs = 5 * 60 * 1000; // 5 minutes
        let timedOut = false;
        const timeout = setTimeout(() => {
            try {
                proc.kill('SIGKILL');
                timedOut = true;
            } catch {}
        }, timeoutMs);

        const code = await proc.exited;
        clearTimeout(timeout);
        if (timedOut) throw new Error('YTDLP_TIMEOUT');
        if (code !== 0) {
            const err = await new Response(proc.stderr).text();
            throw new Error('YTDLP_FAILED: ' + err);
        }

        const path = await findById(videosDir, VIDEO_ID);
        expect(path).toBeTruthy();
        const size = path ? Bun.file(path).size : 0;
        expect(size).toBeGreaterThan(0);
        console.log('Downloaded file:', path, 'size:', size);
    });
});
