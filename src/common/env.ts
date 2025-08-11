/**
 * Robust env access that prefers Bun.env (if present) and falls back to process.env.
 * This avoids jank when running under Bun vs Vitest's node environment.
 */
export function readEnv(key: string): string | undefined {
    // @ts-ignore
    const bunEnv =
        typeof Bun !== 'undefined'
            ? (Bun.env as Record<string, string | undefined>)
            : undefined;
    return bunEnv?.[key] ?? process.env[key];
}

export function requireEnv(key: string): string {
    const val = readEnv(key);
    if (val == null || val === '') {
        throw new Error(`Missing required env: ${key}`);
    }
    return val;
}

export function readIntEnv(
    key: string,
    defaultValue?: number
): number | undefined {
    const v = readEnv(key);
    if (v == null || v === '') return defaultValue;
    const n = Number(v);
    if (Number.isNaN(n)) return defaultValue;
    return n;
}
