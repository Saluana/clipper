import { describe, it, expect } from 'vitest';
import { validateRange, coerceNearZeroDuration } from '../time';

describe('validation & coercion helpers', () => {
    it('validates start < end and max duration', () => {
        const ok = validateRange('00:00:00', '00:00:05', {
            maxDurationSec: 10,
        });
        expect(ok.ok).toBe(true);
        const tooLong = validateRange('00:00:00', '00:00:15', {
            maxDurationSec: 10,
        });
        expect(tooLong.ok).toBe(false);
    });

    it('coerces near-zero when enabled', () => {
        const start = 0;
        const end = 0.1;
        const { startSec, endSec, coerced } = coerceNearZeroDuration(
            start,
            end,
            {
                minDurationSec: 0.5,
                coerce: true,
            }
        );
        expect(coerced).toBe(true);
        expect(endSec - startSec).toBeCloseTo(0.5, 3);
    });

    it('does not coerce when disabled', () => {
        const start = 0;
        const end = 0.1;
        const { coerced } = coerceNearZeroDuration(start, end, {
            minDurationSec: 0.5,
            coerce: false,
        });
        expect(coerced).toBe(false);
    });
});
