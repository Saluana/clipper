#!/usr/bin/env bun
/**
 * Dev orchestrator: runs API, worker, ASR worker, and DLQ consumer in watch mode.
 * Uses Bun.spawn to manage child processes; forwards signals for clean shutdown.
 */

type Proc = {
    label: string;
    p: ReturnType<typeof Bun.spawn>;
};

const procs: Proc[] = [];

async function run() {
    const cmds: { label: string; cmd: string[] }[] = [
        { label: 'api', cmd: ['bun', '--watch', 'src/api/index.ts'] },
        { label: 'worker', cmd: ['bun', '--watch', 'src/worker/index.ts'] },
        { label: 'asr', cmd: ['bun', '--watch', 'src/worker/asr.start.ts'] },
        { label: 'dlq', cmd: ['bun', '--watch', 'src/queue/dlq-consumer.ts'] },
        { label: 'reaper', cmd: ['bun', '--watch', 'scripts/reaper.ts'] },
    ];

    for (const { label, cmd } of cmds) {
        const child = Bun.spawn({
            cmd,
            stdout: 'inherit',
            stderr: 'inherit',
            stdin: 'inherit',
        });
        procs.push({ label, p: child });
        console.log(`[dev-all] started ${label} (pid ${child.pid})`);
    }

    const shutdown = async (signal: string) => {
        console.log(`\n[dev-all] received ${signal}, shutting down...`);
        for (const { label, p } of procs) {
            try {
                console.log(
                    `[dev-all] sending terminate to ${label} (pid ${p.pid})`
                );
                // Send default termination signal
                p.kill();
            } catch (err) {
                console.error(`[dev-all] error signaling ${label}:`, err);
            }
        }
        await Promise.allSettled(procs.map(({ p }) => p.exited));
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // If any child exits, shut down the rest and exit non-zero.
    await Promise.race(
        procs.map(({ label, p }) =>
            p.exited.then((code: number) => {
                console.error(`[dev-all] ${label} exited with code ${code}`);
                return { label, code } as const;
            })
        )
    );
    await shutdown('child-exit');
}

run().catch((err) => {
    console.error('[dev-all] fatal error:', err);
    process.exit(1);
});
