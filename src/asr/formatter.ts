import type { AsrProviderSegment } from './provider';

export interface BuildArtifactsOptions {
    includeJson?: boolean;
    mergeGapMs?: number; // default 150ms
    maxLineChars?: number; // default 120
}

export interface BuiltArtifacts {
    srt: string;
    text: string;
    json?: Array<{ start: number; end: number; text: string }>;
}

export function buildArtifacts(
    segments: AsrProviderSegment[],
    opts: BuildArtifactsOptions = {}
): BuiltArtifacts {
    const mergeGapMs = opts.mergeGapMs ?? 150;
    const maxLineChars = opts.maxLineChars ?? 120;

    const norm = normalizeSegments(segments);
    const merged = mergeSegments(norm, mergeGapMs, maxLineChars);
    const srt = buildSrt(merged);
    const text = merged
        .map((s) => s.text)
        .join(' ')
        .trim();
    const out: BuiltArtifacts = { srt, text };
    if (opts.includeJson) {
        out.json = merged.map((s) => ({
            start: s.startSec,
            end: s.endSec,
            text: s.text,
        }));
    }
    return out;
}

function normalizeSegments(inSegs: AsrProviderSegment[]): AsrProviderSegment[] {
    return inSegs
        .map((s) => ({
            startSec: clampNum(s.startSec, 0),
            endSec: clampNum(s.endSec, 0),
            text: sanitizeText(s.text),
            words: s.words?.map((w) => ({
                startSec: clampNum(w.startSec, 0),
                endSec: clampNum(w.endSec, 0),
                text: sanitizeText(w.text),
            })),
        }))
        .filter((s) => s.endSec > s.startSec && s.text.length > 0);
}

function mergeSegments(
    segs: AsrProviderSegment[],
    mergeGapMs: number,
    maxLineChars: number
): AsrProviderSegment[] {
    if (segs.length === 0) return [];
    const out: AsrProviderSegment[] = [];
    let cur: AsrProviderSegment = segs[0]!;
    for (let i = 1; i < segs.length; i++) {
        const next = segs[i]!;
        const gapMs = (next.startSec - cur.endSec) * 1000;
        const combinedLen = (cur.text + ' ' + next.text).length;
        if (gapMs < mergeGapMs && combinedLen <= maxLineChars) {
            cur = {
                startSec: cur.startSec,
                endSec: next.endSec,
                text: (cur.text + ' ' + next.text).trim().replace(/\s+/g, ' '),
            };
        } else {
            out.push(cur);
            cur = next;
        }
    }
    out.push(cur);
    return out;
}

export function buildSrt(segs: AsrProviderSegment[]): string {
    return segs
        .map((s, idx) => {
            const start = formatSrtTime(s.startSec, 'start');
            const end = formatSrtTime(s.endSec, 'end');
            const lines = wrapText(s.text);
            return `${idx + 1}\n${start} --> ${end}\n${lines}\n`;
        })
        .join('\n')
        .trim()
        .concat('\n');
}

function wrapText(t: string, width = 42): string {
    // simple greedy wrap to 1-2 lines if needed
    if (t.length <= width) return t;
    const words = t.split(/\s+/);
    let line = '';
    const lines: string[] = [];
    for (const w of words) {
        if ((line + ' ' + w).trim().length > width && line.length > 0) {
            lines.push(line.trim());
            line = w;
        } else {
            line += (line ? ' ' : '') + w;
        }
    }
    if (line) lines.push(line.trim());
    return lines.slice(0, 2).join('\n');
}

function formatSrtTime(sec: number, kind: 'start' | 'end'): string {
    // start floors ms; end ceils ms to avoid overlaps
    const msFloat = sec * 1000;
    const ms = kind === 'start' ? Math.floor(msFloat) : Math.ceil(msFloat);
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    const mm = (ms % 1000).toString().padStart(3, '0');
    return `${h.toString().padStart(2, '0')}:${m
        .toString()
        .padStart(2, '0')}:${s.toString().padStart(2, '0')},${mm}`;
}

function sanitizeText(t: string): string {
    // Normalize whitespace, remove control chars except \n
    const normalized = (t ?? '').normalize('NFKC');
    const stripped = normalized.replace(/[\u0000-\u001F\u007F]/g, (ch) =>
        ch === '\n' ? '\n' : ' '
    );
    return stripped.trim().replace(/\s+/g, ' ');
}

function clampNum(n: number, min: number): number {
    return Number.isFinite(n) ? Math.max(min, n) : min;
}
