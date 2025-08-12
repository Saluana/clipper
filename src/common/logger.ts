import { redactSecrets } from './redact';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
    level: LogLevel;
    with(fields: Record<string, unknown>): Logger;
    debug(msg: string, fields?: Record<string, unknown>): void;
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
}

function emit(
    level: LogLevel,
    base: Record<string, unknown>,
    msg: string,
    fields?: Record<string, unknown>
) {
    // Apply redaction to message & structured fields
    const redactedBase = redactSecrets(base) as Record<string, unknown>;
    const redactedFields = redactSecrets(fields ?? ({} as any)) as Record<
        string,
        unknown
    >;
    // Ensure correlationId (if present) not accidentally redacted
    const correlationId =
        (fields as any)?.correlationId || (base as any)?.correlationId;
    if (correlationId) {
        redactedBase.correlationId = correlationId;
        redactedFields.correlationId = correlationId;
    }
    const line = {
        level,
        ts: new Date().toISOString(),
        msg: redactSecrets(msg),
        ...redactedBase,
        ...redactedFields,
    };
    try {
        console[level === 'debug' ? 'log' : level](JSON.stringify(line));
    } catch {
        // Fallback minimal log on serialization error
        try {
            console.error('{"level":"error","msg":"log serialization failed"}');
        } catch {}
    }
}

export function createLogger(
    level: LogLevel = 'info',
    base: Record<string, unknown> = {}
): Logger {
    return {
        level,
        with(additional) {
            return createLogger(level, { ...base, ...additional });
        },
        debug(msg, fields) {
            if (['debug'].includes(level)) emit('debug', base, msg, fields);
        },
        info(msg, fields) {
            if (['debug', 'info'].includes(level))
                emit('info', base, msg, fields);
        },
        warn(msg, fields) {
            if (['debug', 'info', 'warn'].includes(level))
                emit('warn', base, msg, fields);
        },
        error(msg, fields) {
            emit('error', base, msg, fields);
        },
    };
}
