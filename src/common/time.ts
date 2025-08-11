export function parseTimecode(tc: string): number {
    const m = tc.match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (!m) throw new Error('Invalid timecode');
    const [hh, mm, ss, ms] = [
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
        m[4] ? Number(m[4].padEnd(3, '0')) : 0,
    ];
    return hh * 3600 + mm * 60 + ss + ms / 1000;
}

export function formatTimecode(seconds: number): string {
    const sign = seconds < 0 ? '-' : '';
    const s = Math.abs(seconds);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    const core = `${hh.toString().padStart(2, '0')}:${mm
        .toString()
        .padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
    return ms
        ? `${sign}${core}.${ms.toString().padStart(3, '0')}`
        : `${sign}${core}`;
}

export function validateRange(
    startTc: string,
    endTc: string,
    opts: { maxDurationSec: number }
) {
    const start = parseTimecode(startTc);
    const end = parseTimecode(endTc);
    if (!(start < end))
        return { ok: false as const, reason: 'start_not_before_end' };
    if (end - start > opts.maxDurationSec)
        return { ok: false as const, reason: 'duration_exceeds_cap' };
    return { ok: true as const, startSec: start, endSec: end };
}
