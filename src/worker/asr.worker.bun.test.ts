import { describe, test, expect, beforeEach } from 'vitest';
import { startAsrWorker } from '@clipper/worker/asr';
import type { AsrJobRow, AsrArtifactRow, JobRow } from '@clipper/data';
import { storageKeys } from '@clipper/data';
import { spawn as nodeSpawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

class FakeAsrJobsRepo {
    map = new Map<string, AsrJobRow>();
    async create(row: any) {
        const now = new Date().toISOString();
        const rec: AsrJobRow = {
            id: row.id,
            clipJobId: row.clipJobId,
            sourceType: row.sourceType || 'internal',
            sourceKey: row.sourceKey,
            mediaHash: row.mediaHash || 'm',
            modelVersion: row.modelVersion || 'whisper-large-v3-turbo',
            languageHint: row.languageHint,
            status: row.status || 'queued',
            createdAt: now,
            updatedAt: now,
        } as any;
        this.map.set(rec.id, rec);
        return rec;
    }
    async get(id: string) {
        return this.map.get(id) || null;
    }
    async patch(id: string, patch: Partial<AsrJobRow>) {
        const cur = this.map.get(id);
        if (!cur) throw new Error('NOT_FOUND');
        const next: AsrJobRow = {
            ...cur,
            ...patch,
            updatedAt: new Date().toISOString(),
        } as any;
        this.map.set(id, next);
        return next;
    }
    async getReusable() {
        return null;
    }
}

class FakeAsrArtifactsRepo {
    items: AsrArtifactRow[] = [];
    async put(a: AsrArtifactRow) {
        this.items.push(a);
    }
    async list(asrJobId: string) {
        return this.items.filter((i) => i.asrJobId === asrJobId);
    }
}

class FakeJobsRepo {
    map = new Map<string, JobRow>();
    async get(id: string) {
        return this.map.get(id) || null;
    }
    async update(id: string, patch: Partial<JobRow>) {
        const cur = this.map.get(id);
        if (!cur) throw new Error('NOT_FOUND');
        const next = { ...cur, ...patch } as JobRow;
        this.map.set(id, next);
        return next;
    }
    async transition(id: string) {
        return this.get(id) as any;
    }
}

class FakeStorage {
    files = new Map<string, Uint8Array>();
    async upload(localPath: string, key: string, _ct?: string) {
        const ab = await Bun.file(localPath).arrayBuffer();
        this.files.set(key, new Uint8Array(ab));
    }
    async download(key: string): Promise<string> {
        const content = this.files.get(key);
        if (!content) throw new Error('NO_SUCH_KEY');
        const tmp = `/tmp/${crypto.randomUUID()}.bin`;
        await Bun.write(tmp, content);
        return tmp;
    }
    async sign() {
        return 'http://example.com';
    }
    async remove() {}
}

class FakeProvider {
    async transcribe(_path: string, _opts: any) {
        return {
            segments: [
                { startSec: 0, endSec: 1.0, text: 'Hello' },
                { startSec: 1.05, endSec: 2.0, text: 'world' },
            ],
            detectedLanguage: 'en',
            modelVersion: 'whisper-large-v3-turbo',
            durationSec: 2,
        };
    }
}

class FakeQueue {
    payload: any;
    constructor(payload: any) {
        this.payload = payload;
    }
    async consumeFrom(_topic: string, handler: (msg: any) => Promise<void>) {
        await handler(this.payload);
    }
}

describe('ASR Worker', () => {
    let storage: FakeStorage;
    let asrJobs: FakeAsrJobsRepo;
    let artifacts: FakeAsrArtifactsRepo;
    let clipJobs: FakeJobsRepo;

    beforeEach(async () => {
        storage = new FakeStorage();
        asrJobs = new FakeAsrJobsRepo();
        artifacts = new FakeAsrArtifactsRepo();
        clipJobs = new FakeJobsRepo();
    });

    test('processes job: downloads clip, transcribes, uploads artifacts, and marks done', async () => {
        const clipJobId = crypto.randomUUID();
        const asrJobId = crypto.randomUUID();

        // Seed clip job with a result video key and place content in storage under that key
        const clipKey = storageKeys.resultVideo(clipJobId);
        const clipTmp = `/tmp/${crypto.randomUUID()}.mp4`;
        await Bun.write(clipTmp, 'FAKE_MP4_DATA');
        // Put the source video in storage under result key so download works
        await storage.upload(clipTmp, clipKey, 'video/mp4');

        clipJobs.map.set(clipJobId, {
            id: clipJobId,
            status: 'done',
            progress: 100,
            sourceType: 'upload',
            startSec: 0,
            endSec: 2,
            withSubtitles: false,
            burnSubtitles: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            resultVideoKey: clipKey,
        } as any);

        await asrJobs.create({
            id: asrJobId,
            clipJobId,
            sourceType: 'internal',
            mediaHash: 'm',
            modelVersion: 'whisper-large-v3-turbo',
            status: 'queued',
        });

        const provider = new FakeProvider();
        const payload = { asrJobId, clipJobId, languageHint: 'auto' };
        const queue = new FakeQueue(payload);

        await startAsrWorker({
            queue,
            asrJobs: asrJobs as any,
            clipJobs: clipJobs as any,
            artifacts: artifacts as any,
            storage: storage as any,
            provider: provider as any,
        });

        const updated = await asrJobs.get(asrJobId);
        expect(updated?.status).toBe('done');
        expect(updated?.detectedLanguage).toBe('en');

        const list = await artifacts.list(asrJobId);
        const kinds = list.map((a) => a.kind).sort();
        expect(kinds).toEqual(['srt', 'text']);

        const srtKey = storageKeys.transcriptSrt(clipJobId);
        const txtKey = storageKeys.transcriptText(clipJobId);
        const srt = new TextDecoder().decode(storage.files.get(srtKey)!);
        const txt = new TextDecoder().decode(storage.files.get(txtKey)!);
        expect(srt).toContain('-->');
        expect(txt).toContain('Hello world');
    });

    test('burn-in path: when burnSubtitles=true, produces burned video and keeps original', async () => {
        // Probe ffmpeg availability; if missing, skip test
        const hasFfmpeg = await new Promise<boolean>((resolve) => {
            const p = nodeSpawn('ffmpeg', ['-version'], { stdio: 'ignore' });
            p.on('error', () => resolve(false));
            p.on('close', (code) => resolve((code ?? 1) === 0));
        });
        if (!hasFfmpeg) return; // skip gracefully
        // Generate a tiny color clip using ffmpeg (requires ffmpeg in PATH)
        const makeSample = async (out: string) => {
            const args = [
                '-y',
                '-f',
                'lavfi',
                '-i',
                'color=c=black:s=160x120:d=2',
                '-c:v',
                'libx264',
                '-pix_fmt',
                'yuv420p',
                out,
            ];
            await new Promise<void>((resolve, reject) => {
                const p = nodeSpawn('ffmpeg', args, { stdio: 'ignore' });
                p.on('error', reject);
                p.on('close', (code) =>
                    code === 0 ? resolve() : reject(new Error('ffmpeg_failed'))
                );
            });
        };

        const clipJobId = crypto.randomUUID();
        const asrJobId = crypto.randomUUID();
        const clipKey = storageKeys.resultVideo(clipJobId);
        const clipTmp = `/tmp/${crypto.randomUUID()}.mp4`;
        await makeSample(clipTmp);
        await storage.upload(clipTmp, clipKey, 'video/mp4');

        clipJobs.map.set(clipJobId, {
            id: clipJobId,
            status: 'done',
            progress: 100,
            sourceType: 'upload',
            startSec: 0,
            endSec: 2,
            withSubtitles: true,
            burnSubtitles: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            resultVideoKey: clipKey,
        } as any);

        await asrJobs.create({
            id: asrJobId,
            clipJobId,
            sourceType: 'internal',
            mediaHash: 'm',
            modelVersion: 'whisper-large-v3-turbo',
            status: 'queued',
        });

        const provider = new FakeProvider();
        const payload = { asrJobId, clipJobId, languageHint: 'auto' };
        const queue = new FakeQueue(payload);

        await startAsrWorker({
            queue,
            asrJobs: asrJobs as any,
            clipJobs: clipJobs as any,
            artifacts: artifacts as any,
            storage: storage as any,
            provider: provider as any,
        });

        const updatedClip = await clipJobs.get(clipJobId);
        expect(updatedClip?.resultVideoKey).toBe(clipKey);
        expect(updatedClip?.resultVideoBurnedKey).toBe(
            storageKeys.resultVideoBurned(clipJobId)
        );

        // Ensure the burned asset exists in fake storage and is non-zero after download
        const burnedKey = updatedClip?.resultVideoBurnedKey!;
        const local = await storage.download(burnedKey);
        const st = await stat(local);
        expect(st.size).toBeGreaterThan(0);
    }, 60000);
    test('failure path: provider throws -> job failed and no artifacts', async () => {
        const clipJobId = crypto.randomUUID();
        const asrJobId = crypto.randomUUID();
        const clipKey = storageKeys.resultVideo(clipJobId);
        const clipTmp = `/tmp/${crypto.randomUUID()}.mp4`;
        await Bun.write(clipTmp, 'FAKE_MP4_DATA');
        await storage.upload(clipTmp, clipKey, 'video/mp4');
        clipJobs.map.set(clipJobId, {
            id: clipJobId,
            status: 'done',
            progress: 100,
            sourceType: 'upload',
            startSec: 0,
            endSec: 2,
            withSubtitles: false,
            burnSubtitles: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            resultVideoKey: clipKey,
        } as any);
        await asrJobs.create({
            id: asrJobId,
            clipJobId,
            sourceType: 'internal',
            mediaHash: 'm',
            modelVersion: 'whisper-large-v3-turbo',
            status: 'queued',
        });
        class FailingProvider {
            async transcribe() {
                throw new Error('PROVIDER_FAIL');
            }
        }
        const queue = new FakeQueue({
            asrJobId,
            clipJobId,
            languageHint: 'auto',
        });
        await expect(
            startAsrWorker({
                queue,
                asrJobs: asrJobs as any,
                clipJobs: clipJobs as any,
                artifacts: artifacts as any,
                storage: storage as any,
                provider: new FailingProvider() as any,
            })
        ).rejects.toThrow();
        const updated = await asrJobs.get(asrJobId);
        expect(updated?.status).toBe('failed');
        const list = await artifacts.list(asrJobId);
        expect(list.length).toBe(0);
    });
});
