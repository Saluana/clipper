import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { classifyError, getMaxRetries } from './retry';

const envBackup: Record<string, string | undefined> = {};

function setEnv(k: string, v?: string) {
    if (!(k in envBackup)) envBackup[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
}

function restoreEnv() {
    for (const [k, v] of Object.entries(envBackup)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
}

describe('retry utils', () => {
    beforeEach(() => {
        // clear relevant envs before each test
        setEnv('MAX_RETRIES', undefined);
        setEnv('JOB_MAX_ATTEMPTS', undefined);
    });
    afterEach(() => {
        restoreEnv();
    });

    it('classifyError: retryable for transient/storage/network/timeout', () => {
        expect(classifyError(new Error('storage_upload_failed'))).toBe(
            'retryable'
        );
        expect(classifyError(new Error('CLIP_TIMEOUT'))).toBe('retryable');
        expect(classifyError(new Error('ECONNRESET'))).toBe('retryable');
        expect(classifyError(new Error('fetch timeout 504'))).toBe('retryable');
    });

    it('classifyError: fatal for verification/validation/source issues or empty output', () => {
        expect(classifyError(new Error('OUTPUT_MISSING'))).toBe('fatal');
        expect(
            classifyError({
                error: { code: 'OUTPUT_VERIFICATION_FAILED' },
            } as any)
        ).toBe('fatal');
        expect(
            classifyError({ error: { code: 'VALIDATION_FAILED' } } as any)
        ).toBe('fatal');
        expect(
            classifyError({ error: { code: 'SOURCE_UNREADABLE' } } as any)
        ).toBe('fatal');
    });

    it('getMaxRetries: defaults to 3 with no envs', () => {
        expect(getMaxRetries()).toBe(3);
    });

    it('getMaxRetries: prefers MAX_RETRIES over JOB_MAX_ATTEMPTS', () => {
        setEnv('JOB_MAX_ATTEMPTS', '2');
        setEnv('MAX_RETRIES', '5');
        expect(getMaxRetries()).toBe(5);
    });

    it('getMaxRetries: falls back to JOB_MAX_ATTEMPTS when MAX_RETRIES unset', () => {
        setEnv('JOB_MAX_ATTEMPTS', '4');
        expect(getMaxRetries()).toBe(4);
    });
});
