import { readEnv } from '@clipper/common';

export type RetryClass = 'retryable' | 'fatal';

export function getMaxRetries(): number {
    const max = Number(
        readEnv('MAX_RETRIES') || readEnv('JOB_MAX_ATTEMPTS') || 3
    );
    return Number.isFinite(max) && max > 0 ? Math.floor(max) : 3;
}

export function classifyError(e: unknown): RetryClass {
    const msg = String((e as any)?.message || e || '');
    // Known transient/network/storage
    if (
        /CLIP_TIMEOUT|STORAGE_NOT_AVAILABLE|storage_upload_failed|timeout|fetch|network|ECONN|EAI_AGAIN|ENOTFOUND|5\d{2}/i.test(
            msg
        )
    ) {
        return 'retryable';
    }
    // Output missing/empty -> fatal
    if (/OUTPUT_EMPTY|OUTPUT_MISSING/i.test(msg)) return 'fatal';
    // ServiceError code-based hints when available
    const code = (e as any)?.error?.code || (e as any)?.code;
    if (typeof code === 'string') {
        if (
            /VALIDATION_FAILED|OUTPUT_VERIFICATION_FAILED|SOURCE_UNREADABLE/i.test(
                code
            )
        ) {
            return 'fatal';
        }
    }
    return 'fatal';
}
