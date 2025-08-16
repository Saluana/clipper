#!/usr/bin/env bun
/**
 * Submit a clip job to the local API and poll until result is ready.
 * Usage:
 *  bun scripts/submit-and-poll.ts --url <youtubeUrl> --start 00:01:00 --end 00:01:45 --lang en [--burn]
 */

function parseArgs() {
    const args = new Map<string, string | boolean>();
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (!next || next.startsWith('--')) {
                args.set(key, true);
            } else {
                args.set(key, next);
                i++;
            }
        }
    }
    return args;
}

const args = parseArgs();
const youtubeUrl = String(args.get('url') || args.get('youtube') || '');
const start = String(args.get('start') || '');
const end = String(args.get('end') || '');
const lang = String(args.get('lang') || 'en');
const burn = Boolean(args.get('burn') || false);

if (!youtubeUrl || !start || !end) {
    console.error(
        'Usage: bun scripts/submit-and-poll.ts --url <youtubeUrl> --start 00:MM:SS --end 00:MM:SS --lang en [--burn]'
    );
    process.exit(2);
}

const API = process.env.API_BASE_URL || 'http://localhost:3000';

async function submitJob() {
    const payload = {
        sourceType: 'youtube',
        youtubeUrl,
        start,
        end,
        withSubtitles: true,
        subtitleLang: lang,
        burnSubtitles: burn,
    };
    const res = await fetch(`${API}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Create failed ${res.status}: ${txt}`);
    }
    const data = await res.json();
    const id = data?.job?.id || data?.id || data?.jobId;
    if (!id) throw new Error(`No job id in response: ${JSON.stringify(data)}`);
    return id as string;
}

async function getResult(id: string) {
    const res = await fetch(`${API}/api/jobs/${id}/result`);
    if (res.status === 404) return null; // not ready
    if (!res.ok)
        throw new Error(`Result failed ${res.status}: ${await res.text()}`);
    return await res.json();
}

async function main() {
    console.log(
        `[submit] creating job for ${youtubeUrl} from ${start} to ${end} (lang=${lang}, burn=${burn})`
    );
    const id = await submitJob();
    console.log(`[submit] job id: ${id}`);
    const startTs = Date.now();
    const timeoutMs = 15 * 60_000; // 15 minutes
    const pollMs = 5_000;
    while (true) {
        if (Date.now() - startTs > timeoutMs)
            throw new Error('Timed out waiting for result');
        const res = await getResult(id);
        if (res) {
            const r = res.result || res;
            console.log('\n=== Clip Ready ===');
            console.log(`Job: ${r.id || id}`);
            if (r.video?.url) console.log(`Video: ${r.video.url}`);
            if (r.burnedVideo?.url) console.log(`Burned: ${r.burnedVideo.url}`);
            if (r.srt?.url) console.log(`SRT: ${r.srt.url}`);
            return;
        }
        process.stdout.write('.');
        await new Promise((r) => setTimeout(r, pollMs));
    }
}

main().catch((e) => {
    console.error('\n[submit] error:', e?.message || e);
    process.exit(1);
});
