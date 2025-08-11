import { describe, it, expect } from 'vitest';
import { Schemas } from '../index';

describe('Contracts Schemas', () => {
    it('validates CreateJobInput upload', () => {
        const input = {
            sourceType: 'upload',
            uploadKey: 'sources/abc.mp4',
            start: '00:00:01.000',
            end: '00:00:05.000',
            withSubtitles: false,
            burnSubtitles: false,
        };
        const res = Schemas.CreateJobInput.safeParse(input);
        expect(res.success).toBe(true);
    });

    it('rejects mismatched source fields', () => {
        const input = {
            sourceType: 'youtube',
            uploadKey: 'sources/abc.mp4',
            start: '00:00:01',
            end: '00:00:02',
            withSubtitles: false,
            burnSubtitles: false,
        } as any;
        const res = Schemas.CreateJobInput.safeParse(input);
        expect(res.success).toBe(false);
    });

    it('job record roundtrip', () => {
        const now = new Date().toISOString();
        const job = {
            id: crypto.randomUUID(),
            status: 'queued',
            progress: 0,
            createdAt: now,
            updatedAt: now,
            expiresAt: now,
        };
        const parsed = Schemas.JobRecord.parse(job);
        expect(parsed).toEqual(job);
    });
});
