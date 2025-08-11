import {
    pgEnum,
    pgTable,
    text,
    timestamp,
    uuid,
    integer,
    boolean,
    jsonb,
    index,
} from 'drizzle-orm/pg-core';

// Enums
export const jobStatus = pgEnum('job_status', [
    'queued',
    'processing',
    'done',
    'failed',
]);
export const sourceType = pgEnum('source_type', ['upload', 'youtube']);

// jobs table
export const jobs = pgTable(
    'jobs',
    {
        id: uuid('id').primaryKey(),
        status: jobStatus('status').notNull().default('queued'),
        progress: integer('progress').notNull().default(0),
        sourceType: sourceType('source_type').notNull(),
        sourceKey: text('source_key'),
        sourceUrl: text('source_url'),
        startSec: integer('start_sec').notNull(),
        endSec: integer('end_sec').notNull(),
        withSubtitles: boolean('with_subtitles').notNull().default(false),
        burnSubtitles: boolean('burn_subtitles').notNull().default(false),
        subtitleLang: text('subtitle_lang'),
        resultVideoKey: text('result_video_key'),
        resultSrtKey: text('result_srt_key'),
        errorCode: text('error_code'),
        errorMessage: text('error_message'),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        expiresAt: timestamp('expires_at', { withTimezone: true }),
    },
    (t) => [
        index('idx_jobs_status_created_at').on(t.status, t.createdAt),
        index('idx_jobs_expires_at').on(t.expiresAt),
    ]
);

// job_events table
export const jobEvents = pgTable(
    'job_events',
    {
        jobId: uuid('job_id')
            .notNull()
            .references(() => jobs.id, { onDelete: 'cascade' }),
        ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
        type: text('type').notNull(),
        data: jsonb('data'),
    },
    (t) => [index('idx_job_events_job_id_ts').on(t.jobId, t.ts)]
);

// api_keys table (optional)
export const apiKeys = pgTable('api_keys', {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(),
    revoked: boolean('revoked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobEvent = typeof jobEvents.$inferSelect;
export type NewJobEvent = typeof jobEvents.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
