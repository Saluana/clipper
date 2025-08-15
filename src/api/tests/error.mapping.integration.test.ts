import 'dotenv/config';
import { describe, test, expect } from 'vitest';
import { app } from '../index';
import { DrizzleJobsRepo, DrizzleJobEventsRepo, createDb } from '@clipper/data';

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)('API error envelope mapping', () => {
    test('maps failed job errorCode to stable envelope (OUTPUT_VERIFICATION_FAILED → 422)', async () => {
        const db = createDb();
        const jobs = new DrizzleJobsRepo(db as any);
        const events = new DrizzleJobEventsRepo(db as any);
        const id = crypto.randomUUID();
        await jobs.create({
            id,
            status: 'failed',
            progress: 0,
            sourceType: 'upload',
            sourceKey: 'k',
            sourceUrl: null,
            startSec: 0,
            endSec: 1,
            withSubtitles: false,
            burnSubtitles: false,
            subtitleLang: null,
            resultVideoKey: null,
            resultSrtKey: null,
            errorCode: 'OUTPUT_VERIFICATION_FAILED',
            errorMessage: 'faststart_missing',
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        } as any);
        await events.add({
            jobId: id,
            ts: new Date().toISOString(),
            type: 'failed',
            data: { reason: 'faststart_missing' },
        });

        const res = await app.handle(
            new Request(`http://local/api/jobs/${id}/result`, {
                headers: { 'x-request-id': 'req' },
            })
        );
        expect(res.status).toBe(422);
        const body = (await res.json()) as any;
        expect(body.error.code).toBe('OUTPUT_VERIFICATION_FAILED');
        expect(body.error.message).toBe('faststart_missing');
        expect(body.error.correlationId).toBe('req');
    });

    test('maps retries exhausted to 422', async () => {
        const db = createDb();
        const jobs = new DrizzleJobsRepo(db as any);
        const id = crypto.randomUUID();
        await jobs.create({
            id,
            status: 'failed',
            progress: 0,
            sourceType: 'upload',
            sourceKey: 'k',
            sourceUrl: null,
            startSec: 0,
            endSec: 1,
            withSubtitles: false,
            burnSubtitles: false,
            subtitleLang: null,
            resultVideoKey: null,
            resultSrtKey: null,
            errorCode: 'RETRIES_EXHAUSTED',
            errorMessage: 'gave up',
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        } as any);
        const res = await app.handle(
            new Request(`http://local/api/jobs/${id}/result`, {
                headers: { 'x-request-id': 'rid' },
            })
        );
        expect(res.status).toBe(422);
        const body = (await res.json()) as any;
        expect(body.error.code).toBe('RETRIES_EXHAUSTED');
        expect(body.error.correlationId).toBe('rid');
    });
});
