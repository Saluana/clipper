// Global test setup: minimal Bun polyfill for vitest environment
import { readFile, writeFile, stat } from 'node:fs/promises';
import { spawn as nodeSpawn } from 'node:child_process';

if (!(globalThis as any).Bun) {
    (globalThis as any).Bun = {
        version: '1.0.0-test',
        async write(path: string, data: any) {
            const buf =
                data instanceof Uint8Array || Buffer.isBuffer(data)
                    ? data
                    : Buffer.from(data);
            await writeFile(path, buf);
            return buf.length;
        },
        file(path: string) {
            return {
                async arrayBuffer() {
                    const buf = await readFile(path);
                    return buf.buffer.slice(
                        buf.byteOffset,
                        buf.byteOffset + buf.byteLength
                    );
                },
                async text() {
                    const buf = await readFile(path);
                    return buf.toString('utf8');
                },
                async exists() {
                    try {
                        await stat(path);
                        return true;
                    } catch {
                        return false;
                    }
                },
                stream() {
                    const fs = require('node:fs');
                    const rs = fs.createReadStream(path);
                    return (async function* () {
                        for await (const chunk of rs) {
                            yield new Uint8Array(chunk as any);
                        }
                    })();
                },
                get size() {
                    try {
                        return require('node:fs').statSync(path).size;
                    } catch {
                        return 0;
                    }
                },
            } as any;
        },
        spawn(args: string[], opts: any = {}) {
            const proc: any = nodeSpawn(
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
                    } catch {
                        /* ignore */
                    }
                },
            } as any;
        },
    };
} else {
    // Ensure version exists for libraries calling Bun.version.split
    if (!(globalThis as any).Bun.version) {
        (globalThis as any).Bun.version = '1.0.0-test';
    }
}
