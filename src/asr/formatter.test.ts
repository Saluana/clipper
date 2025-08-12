import { describe, it, expect } from 'vitest';
import { buildSrt, buildArtifacts } from './formatter';
import type { AsrProviderSegment } from './provider';

function seg(a: number, b: number, t: string): AsrProviderSegment {
    return { startSec: a, endSec: b, text: t };
}

describe('formatter', () => {
    it('formats SRT time and wraps text', () => {
        const s: AsrProviderSegment[] = [
            seg(
                0,
                1.2345,
                'Hello world this is a very long line that probably needs wrapping to look nice'
            ),
        ];
        const srt = buildSrt(s);
        expect(srt).toContain('00:00:00,000 --> 00:00:01,235');
        const lines = srt.split('\n');
        const textLine = lines[2] ?? '';
        expect(textLine.length).toBeLessThanOrEqual(42);
    });

    it('merges close segments within gap and max chars', () => {
        const s: AsrProviderSegment[] = [
            seg(0.0, 1.0, 'Hello'),
            seg(1.05, 2.0, 'world'), // 50ms gap
            seg(2.5, 3.0, 'next'), // big gap, no merge
        ];
        const { text, json } = buildArtifacts(s, {
            includeJson: true,
            mergeGapMs: 150,
            maxLineChars: 120,
        });
        expect(text).toBe('Hello world next');
        expect(json).toHaveLength(2);
        expect(json?.[0]).toEqual({ start: 0, end: 2, text: 'Hello world' });
        expect(json?.[1]).toEqual({ start: 2.5, end: 3, text: 'next' });
    });

    it('sanitizes control characters and collapses whitespace', () => {
        const s: AsrProviderSegment[] = [
            seg(0, 1, 'Hi\u0007 there  \n friend'),
        ];
        const { text } = buildArtifacts(s);
        expect(text).toBe('Hi there friend');
    });

    it('does not merge when combined text would exceed maxLineChars', () => {
        const longA = 'a'.repeat(80);
        const longB = 'b'.repeat(50);
        const s: AsrProviderSegment[] = [
            seg(0, 1, longA),
            seg(1.1, 2, longB), // 100ms gap but combined would be 131 (>120)
        ];
        const { json } = buildArtifacts(s, {
            includeJson: true,
            mergeGapMs: 150,
            maxLineChars: 120,
        });
        expect(json).toHaveLength(2);
    });

    it('uses floor for start and ceil for end timestamps', () => {
        const s: AsrProviderSegment[] = [
            seg(0.001, 0.001, 'x'), // will be filtered (end<=start)
            seg(0.001, 0.0015, 'A'),
            seg(1.0004, 1.0006, 'B'),
        ];
        const srt = buildArtifacts(s).srt;
        // Expect start 0.001 -> 00:00:00,001 and end 0.0015 -> 00:00:00,002
        expect(srt).toContain('00:00:00,001 --> 00:00:00,002');
        // For 1.0004-1.0006, expect 00:00:01,000 --> 00:00:01,001
        expect(srt).toContain('00:00:01,000 --> 00:00:01,001');
    });

    it('normalizes Unicode to NFKC in sanitizeText', () => {
        // full-width digits -> ASCII via NFKC
        const s: AsrProviderSegment[] = [seg(0, 1, '１２３ abc')];
        const { text } = buildArtifacts(s);
        expect(text).toBe('123 abc');
    });
});
