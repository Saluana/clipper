import { describe, it, expect } from 'vitest';
import { loadConfig } from '../config';
import { parseTimecode, formatTimecode, validateRange } from '../time';
import { transition } from '../state';
describe('config loader', () => {
    it('loads valid config', () => {
        const cfg = loadConfig({
            NODE_ENV: 'test',
            LOG_LEVEL: 'debug',
            SUPABASE_URL: 'https://example.supabase.co',
            SUPABASE_ANON_KEY: 'aaaaaaaaaa',
            ENABLE_YTDLP: 'true',
            CLIP_MAX_DURATION_SEC: '120',
        });
        expect(cfg.ENABLE_YTDLP).toBe(true);
        expect(cfg.CLIP_MAX_DURATION_SEC).toBe(120);
    });
    it('throws on invalid config', () => {
        expect(() => loadConfig({})).toThrow();
    });
});
describe('time utils', () => {
    it('parses and formats timecode', () => {
        const s = parseTimecode('00:00:01.250');
        expect(s).toBeCloseTo(1.25, 3);
        expect(formatTimecode(s)).toBe('00:00:01.250');
    });
    it('validates range with cap', () => {
        const ok = validateRange('00:00:00', '00:00:10', {
            maxDurationSec: 15,
        });
        expect(ok.ok).toBe(true);
        const bad = validateRange('00:00:10', '00:00:09', {
            maxDurationSec: 15,
        });
        expect(bad.ok).toBe(false);
    });
});
describe('state machine', () => {
    it('allows valid transitions', () => {
        const t = transition('queued', 'processing');
        expect(t.from).toBe('queued');
        expect(t.to).toBe('processing');
    });
    it('rejects invalid transitions', () => {
        expect(() => transition('queued', 'done')).toThrow();
    });
});
