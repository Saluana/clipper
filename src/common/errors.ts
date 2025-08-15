import { redactSecrets } from './redact';
export type ServiceErrorCode =
    | 'BAD_REQUEST'
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'RATE_LIMITED'
    | 'INTERNAL'
    | 'INVALID_STATE'
    | 'VALIDATION_FAILED'
    | 'SOURCE_UNREADABLE';

export interface ErrorEnvelope {
    code: ServiceErrorCode;
    message: string;
    details?: unknown;
    correlationId?: string;
}

export class ServiceError extends Error {
    constructor(
        public code: ServiceErrorCode,
        message: string,
        public details?: unknown
    ) {
        super(message);
        this.name = 'ServiceError';
    }
}

export type Ok<T> = { ok: true; value: T };
export type Err = { ok: false; error: ErrorEnvelope };
export type ServiceResult<T> = Ok<T> | Err;

export function ok<T>(value: T): Ok<T> {
    return { ok: true, value };
}
export function err(
    code: ServiceErrorCode,
    message: string,
    details?: unknown,
    correlationId?: string
): Err {
    // Redact secrets in message/details
    return {
        ok: false,
        error: {
            code,
            message: redactSecrets(message),
            details: redactSecrets(details),
            correlationId,
        },
    };
}

export function fromException(e: unknown, correlationId?: string): Err {
    if (e instanceof ServiceError) {
        return err(e.code, e.message, e.details, correlationId);
    }
    const message = e instanceof Error ? e.message : String(e);
    return err('INTERNAL', message, undefined, correlationId);
}
