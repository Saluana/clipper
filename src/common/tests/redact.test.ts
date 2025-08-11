import { describe, it, expect } from 'vitest';
import { redactSecrets, redactText } from '../redact';

describe('redact', () => {
    it('redacts ck_ tokens in strings', () => {
        const s =
            'Authorization: ck_123e4567-e89b-12d3-a456-426614174000_abcdEF-12';
        expect(redactText(s)).toContain(
            'ck_123e4567-e89b-12d3-a456-426614174000_[REDACTED]'
        );
    });
    it('redacts bearer tokens', () => {
        const s = 'Bearer abc.def.ghi';
        expect(redactText(s)).toBe('Bearer [REDACTED]');
    });
    it('redacts sensitive object fields', () => {
        const obj = {
            token: 'secret',
            nested: { apiKey: 'x', ok: 'y' },
        } as any;
        const redacted = redactSecrets(obj) as any;
        expect(redacted.token).toBe('[REDACTED]');
        expect(redacted.nested.apiKey).toBe('[REDACTED]');
        expect(redacted.nested.ok).toBe('y');
    });
});
