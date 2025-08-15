import { z } from 'zod';
import type { CreateJobInput as CreateJobInputType } from './types';

export const timecode = z
    .string()
    .regex(/^\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/, 'Expected HH:MM:SS(.ms)');

export const SourceType = z.enum(['upload', 'youtube']);
export const JobStatus = z.enum(['queued', 'processing', 'done', 'failed']);

export const CreateJobInput = z
    .object({
        sourceType: SourceType,
        youtubeUrl: z.string().url().optional(),
        uploadKey: z.string().min(1).optional(),
        start: timecode,
        end: timecode,
        withSubtitles: z.boolean().default(false),
        burnSubtitles: z.boolean().default(false),
        subtitleLang: z
            .union([z.literal('auto'), z.string().min(2)])
            .optional(),
    })
    .superRefine((val: CreateJobInputType, ctx) => {
        if (val.sourceType === 'upload' && !val.uploadKey) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'uploadKey required for sourceType=upload',
                path: ['uploadKey'],
            });
        }
        if (val.sourceType === 'youtube' && !val.youtubeUrl) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'youtubeUrl required for sourceType=youtube',
                path: ['youtubeUrl'],
            });
        }
        if (val.burnSubtitles && !val.withSubtitles) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                    'burnSubtitles requires withSubtitles=true (server-side burn-in depends on SRT)',
                path: ['burnSubtitles'],
            });
        }
        // start/end relationship basic check (detailed limits in API handler)
        try {
            const [sh, sm, ss] = val.start.split(':');
            const [eh, em, es] = val.end.split(':');
            const s = Number(sh) * 3600 + Number(sm) * 60 + Number(ss);
            const e = Number(eh) * 3600 + Number(em) * 60 + Number(es);
            if (!(s < e)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'start must be before end',
                    path: ['start'],
                });
            }
        } catch {}
    });

export const JobRecord = z.object({
    id: z.string().uuid(),
    status: JobStatus,
    progress: z.number().min(0).max(100),
    resultVideoKey: z.string().optional(),
    resultVideoBurnedKey: z.string().optional(),
    resultSrtKey: z.string().optional(),
    error: z.string().optional(),
    expiresAt: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
