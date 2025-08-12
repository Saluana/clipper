import { z } from 'zod';

export const AsrQueuePayloadSchema = z.object({
    asrJobId: z.string().uuid(),
    clipJobId: z.string().uuid().optional(),
    languageHint: z.string().optional(),
});

export type AsrQueuePayload = z.infer<typeof AsrQueuePayloadSchema>;
