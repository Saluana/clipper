import { z } from 'zod';

export const ConfigSchema = z.object({
    NODE_ENV: z
        .enum(['development', 'test', 'production'])
        .default('development'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    SUPABASE_URL: z.string().url(),
    SUPABASE_ANON_KEY: z.string().min(10),
    QUEUE_URL: z.string().url().optional(),
    ENABLE_YTDLP: z.boolean().default(false),
    CLIP_MAX_DURATION_SEC: z.number().int().positive().default(120),
    // Media IO / Source Resolver
    SCRATCH_DIR: z.string().default('/tmp/ytc'),
    MAX_INPUT_MB: z.number().int().positive().default(1024),
    MAX_CLIP_INPUT_DURATION_SEC: z.number().int().positive().default(7200),
    ALLOWLIST_HOSTS: z.string().optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(
    env: Record<string, string | undefined> = process.env
): AppConfig {
    const parsed = ConfigSchema.safeParse({
        ...env,
        ENABLE_YTDLP: env.ENABLE_YTDLP === 'true',
        CLIP_MAX_DURATION_SEC: env.CLIP_MAX_DURATION_SEC
            ? Number(env.CLIP_MAX_DURATION_SEC)
            : undefined,
        MAX_INPUT_MB: env.MAX_INPUT_MB ? Number(env.MAX_INPUT_MB) : undefined,
        MAX_CLIP_INPUT_DURATION_SEC: env.MAX_CLIP_INPUT_DURATION_SEC
            ? Number(env.MAX_CLIP_INPUT_DURATION_SEC)
            : undefined,
    });
    if (!parsed.success) {
        const details = parsed.error.flatten();
        const redacted = Object.fromEntries(
            Object.entries(env).map(([k, v]) => [
                k,
                k.includes('KEY') ? '***' : v,
            ])
        );
        throw new Error(
            'Invalid configuration: ' +
                JSON.stringify({ details, env: redacted })
        );
    }
    return parsed.data;
}
