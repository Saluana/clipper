// Simple secret redaction utilities for logs and error messages.
// - Redacts API tokens in common places (Authorization headers, query params)
// - Redacts our ck_<id>_<secret> API key format
// - Redacts object properties whose keys look sensitive (token, secret, key, password)

const SENSITIVE_KEY_REGEX =
    /^(?:authorization|password|pass|secret|token|api[_-]?key|key)$/i;

function redactString(input: string): string {
    let out = input;
    // Bearer tokens
    out = out.replace(
        /Bearer\s+[A-Za-z0-9\-\._~\+\/]+=*/gi,
        'Bearer [REDACTED]'
    );
    // Query params like ?apikey=...&token=...
    out = out.replace(
        /([?&](?:api|apikey|token|key|secret)=)([^&#\s]+)/gi,
        '$1[REDACTED]'
    );
    // Our API key format: ck_<uuid>_<base64url>
    out = out.replace(
        /\bck_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]+)\b/gi,
        (_m, id) => `ck_${id}_[REDACTED]`
    );
    return out;
}

function redactArray(arr: unknown[]): unknown[] {
    return arr.map((v) => redactSecrets(v));
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = Array.isArray(obj) ? {} : {};
    for (const [k, v] of Object.entries(obj)) {
        if (SENSITIVE_KEY_REGEX.test(k)) {
            out[k] = '[REDACTED]';
            continue;
        }
        out[k] = redactSecrets(v);
    }
    return out;
}

export function redactSecrets<T = unknown>(value: T): T {
    if (value == null) return value;
    if (typeof value === 'string') return redactString(value) as unknown as T;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof Error) {
        const e = value as Error;
        const copy = new Error(redactString(e.message));
        (copy as any).name = e.name;
        (copy as any).stack = e.stack ? redactString(e.stack) : undefined;
        return copy as unknown as T;
    }
    if (Array.isArray(value)) return redactArray(value) as unknown as T;
    if (typeof value === 'object')
        return redactObject(value as any) as unknown as T;
    return value;
}

// Convenience for explicit string redaction when needed
export function redactText(text: string): string {
    return redactString(text);
}
