import { describe, test, expect } from 'bun:test';
import { app } from '../index';

function jsonHeaders(extra: Record<string, string> = {}) {
    return { 'content-type': 'application/json', ...extra };
}

describe('API validation & coercion', () => {
    test('rejects start >= end', async () => {
        const body = {
            sourceType: 'upload',
            uploadKey: 'sources/demo/source.mp4',
            start: '00:00:05',
            end: '00:00:05',
            withSubtitles: false,
            burnSubtitles: false,
        };
        const res = await app.handle(
            new Request('http://test/api/jobs', {
                method: 'POST',
                body: JSON.stringify(body),
                headers: jsonHeaders({ 'x-request-id': 't-start-end' }),
            })
        );
        expect(res.status).toBe(400);
        const json: any = await res.json();
        expect(json.error.code).toBe('VALIDATION_FAILED');
    });

    test('rejects exceeding MAX_CLIP_SECONDS', async () => {
        (Bun.env as any).MAX_CLIP_SECONDS = '2';
        const body = {
            sourceType: 'upload',
            uploadKey: 'sources/demo/source.mp4',
            start: '00:00:00',
            end: '00:00:05',
            withSubtitles: false,
            burnSubtitles: false,
        };
        const res = await app.handle(
            new Request('http://test/api/jobs', {
                method: 'POST',
                body: JSON.stringify(body),
                headers: jsonHeaders({ 'x-request-id': 't-max' }),
            })
        );
        expect(res.status).toBe(400);
        const json: any = await res.json();
        expect(json.error.code).toBe('CLIP_TOO_LONG');
    });

    test('coerces near-zero when enabled', async () => {
        (Bun.env as any).MAX_CLIP_SECONDS = '10';
        (Bun.env as any).MIN_DURATION_SEC = '0.5';
        (Bun.env as any).COERCE_MIN_DURATION = 'true';
        const body = {
            sourceType: 'upload',
            uploadKey: 'sources/demo/source.mp4',
            start: '00:00:00',
            end: '00:00:00.100',
            withSubtitles: false,
            burnSubtitles: false,
        };
        const res = await app.handle(
            new Request('http://test/api/jobs', {
                method: 'POST',
                body: JSON.stringify(body),
                headers: jsonHeaders({ 'x-request-id': 't-coerce' }),
            })
        );
        // Should accept and create job with coerced end
        expect(res.status).toBe(200);
        const json: any = await res.json();
        expect(json.job).toBeTruthy();
        expect(json.job.status).toBe('queued');
    });
});
