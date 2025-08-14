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

    it('rejects burnSubtitles=true when withSubtitles=false', () => {
        const input = {
            sourceType: 'upload',
            uploadKey: 'sources/abc.mp4',
            start: '00:00:01.000',
            end: '00:00:05.000',
            withSubtitles: false,
            burnSubtitles: true,
        } as any;
        const res = Schemas.CreateJobInput.safeParse(input);
        expect(res.success).toBe(false);
        if (!res.success) {
            const msgs = res.error.issues.map((i) => i.message).join('|');
            expect(msgs).toContain('burnSubtitles');
        }
    });

    it('JobRecord allows optional resultVideoBurnedKey', () => {
        const now = new Date().toISOString();
        const job = {
            id: crypto.randomUUID(),
            status: 'done',
            progress: 100,
            createdAt: now,
            updatedAt: now,
            expiresAt: now,
            resultVideoKey: 'results/vid.mp4',
            resultVideoBurnedKey: 'results/vid.subbed.mp4',
        } as any;
        const parsed = Schemas.JobRecord.parse(job);
        expect(parsed.resultVideoBurnedKey).toBe('results/vid.subbed.mp4');
    });
});
