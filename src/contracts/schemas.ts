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
    });

export const JobRecord = z.object({
    id: z.string().uuid(),
    status: JobStatus,
    progress: z.number().min(0).max(100),
    resultVideoKey: z.string().optional(),
    resultSrtKey: z.string().optional(),
    error: z.string().optional(),
    expiresAt: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
