import { describe, it, expect } from 'vitest';
import { BunClipper } from './clipper';
import { mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// This test requires ffmpeg + ffprobe installed in PATH.
// It generates a tiny 2s color video then clips 1s segment.
function run(cmd: string, args: string[]): Promise<number> {
    return new Promise((res, rej) => {
        const p = spawn(cmd, args, { stdio: 'ignore' });
        p.on('error', rej);
        p.on('close', (code) => res(code ?? -1));
    });
}

async function generateSampleVideo(out: string) {
    const args = [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=128x72:d=2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        out,
    ];
    const code = await run('ffmpeg', args);
    if (code !== 0) throw new Error('ffmpeg sample generation failed');
}

// Provide a minimal Bun polyfill when running under vitest (node)
if (!(globalThis as any).Bun) {
    (globalThis as any).Bun = {
        file(path: string) {
            return {
                async arrayBuffer() {
                    const buf = await readFile(path);
                    return buf.buffer.slice(
                        buf.byteOffset,
                        buf.byteOffset + buf.byteLength
                    );
                },
                async exists() {
                    try {
                        await stat(path);
                        return true;
                    } catch {
                        return false;
                    }
                },
                async size() {
                    try {
                        const s = await stat(path);
                        return s.size;
                    } catch {
                        return 0;
                    }
                },
            } as any;
        },
        spawn(args: string[], opts: any = {}) {
            const proc: any = spawn(
                args[0] as string,
                args.slice(1) as string[],
                { stdio: ['ignore', 'pipe', 'pipe'] }
            );
            function toWeb(stream: any) {
                return new ReadableStream<Uint8Array>({
                    start(controller) {
                        stream.on('data', (chunk: any) =>
                            controller.enqueue(new Uint8Array(chunk))
                        );
                        stream.on('end', () => controller.close());
                        stream.on('error', (e: any) => controller.error(e));
                    },
                });
            }
            return {
                stdout: opts.stdout === 'pipe' ? toWeb(proc.stdout) : null,
                stderr: opts.stderr === 'pipe' ? toWeb(proc.stderr) : null,
                exited: new Promise<number>((resolve) =>
                    proc.on('close', (code: any) => resolve(code ?? -1))
                ),
                kill(signal: string) {
                    try {
                        proc.kill(signal as any);
                    } catch (err) {
                        // Ignoring errors during process kill (e.g., process already exited)
                        // console.error('Failed to kill process:', err);
                    }
                },
            } as any;
        },
    };
}

describe('BunClipper integration', () => {
    it('clips a segment and yields progress', async () => {
        const scratch = join(tmpdir(), 'clipper-int');
        await mkdir(scratch, { recursive: true });
        const src = join(scratch, 'source.mp4');
        await generateSampleVideo(src);

        const clipper = new BunClipper({ scratchDir: scratch });
        const jobId = crypto.randomUUID();
        const startSec = 0.2;
        const endSec = 1.2; // 1 second span

        const { localPath, progress$ } = await clipper.clip({
            input: src,
            startSec,
            endSec,
            jobId,
        });

        expect(localPath.endsWith('/clip.mp4')).toBe(true);
        const seen: number[] = [];
        for await (const p of progress$) {
            seen.push(p);
        }
        expect(seen.length).toBeGreaterThan(0);
        expect(seen[0]).toBeGreaterThanOrEqual(0);
        expect(seen.at(-1)).toBe(100);
        // Ensure monotonic
        for (let i = 1; i < seen.length; i++) {
            expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
        }
        // Output file should exist and be non-zero size
        const file = Bun.file(localPath);
        expect(await file.exists()).toBe(true);
        expect(file.size).toBeGreaterThan(0);

        await rm(scratch, { recursive: true, force: true });
    }, 30000);
});
