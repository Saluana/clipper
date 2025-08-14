import { describe, it, expect } from 'vitest';

// Re-import helper via the worker module by accessing the symbol through any-cast
import { __test } from '@clipper/worker/asr';

describe('ASR helpers', () => {
    it('escapeForSubtitlesFilter escapes special chars for ffmpeg subtitles filter', () => {
        const fn = __test.escapeForSubtitlesFilter as (s: string) => string;
        const input = "/tmp/My File:it's,here.srt";
        const out = fn(input);
        expect(out).toContain('My\\ File');
        expect(out).toContain("it\\'s");
        expect(out).toContain('\\:');
        expect(out).toContain('\\,');
    });
});
