/**
 * Consumes an ffmpeg `-progress pipe:1` output stream and yields integer percentage progress values.
 *
 * Contract:
 * - Input: raw ReadableStream<Uint8Array> from ffmpeg stdout configured with `-progress pipe:1`.
 * - Emits: monotonically increasing integers 0..100 (holding at 99 until process exit) then a final 100.
 * - Zero / invalid total duration → emits 100 immediately.
 *
 * Parsing focuses on `out_time_ms` lines; other lines are ignored.
 */
export async function* parseFfmpegProgress(
    stream: ReadableStream<Uint8Array>,
    totalDurationSec: number
): AsyncIterable<number> {
    if (totalDurationSec <= 0 || !Number.isFinite(totalDurationSec)) {
        // Degenerate case: emit 100 immediately
        yield 100;
        return;
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let lastPercent = -1;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
            // Format: out_time_ms=1234567
            if (line.startsWith('out_time_ms=')) {
                const msStr = line.substring('out_time_ms='.length).trim();
                const ms = Number.parseInt(msStr, 10);
                if (!Number.isNaN(ms)) {
                    const sec = ms / 1_000_000;
                    let pct = Math.floor((sec / totalDurationSec) * 100);
                    if (pct >= 100) pct = 99; // hold 100 until process exit
                    if (pct > lastPercent) {
                        lastPercent = pct;
                        yield pct;
                    }
                }
            }
        }
    }
    try {
        reader.releaseLock();
    } catch {}
    if (lastPercent < 100) yield 100;
}
