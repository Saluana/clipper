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
    primaryKey,
} from 'drizzle-orm/pg-core';

// Enums
export const jobStatus = pgEnum('job_status', [
    'queued',
    'processing',
    'done',
    'failed',
]);
export const sourceType = pgEnum('source_type', ['upload', 'youtube']);
export const asrJobStatus = pgEnum('asr_job_status', [
    'queued',
    'processing',
    'done',
    'failed',
]);

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
        lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
        attemptCount: integer('attempt_count').notNull().default(0),
        processingStartedAt: timestamp('processing_started_at', {
            withTimezone: true,
        }),
    },
    (t) => [
        index('idx_jobs_status_created_at').on(t.status, t.createdAt),
        index('idx_jobs_expires_at').on(t.expiresAt),
        index('idx_jobs_status_last_hb').on(t.status, t.lastHeartbeatAt),
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

// ASR tables
export const asrJobs = pgTable(
    'asr_jobs',
    {
        id: uuid('id').primaryKey(),
        clipJobId: uuid('clip_job_id').references(() => jobs.id),
        sourceType: text('source_type').notNull(), // upload | youtube | internal
        sourceKey: text('source_key'),
        mediaHash: text('media_hash').notNull(),
        modelVersion: text('model_version').notNull(),
        languageHint: text('language_hint'),
        detectedLanguage: text('detected_language'),
        durationSec: integer('duration_sec'),
        status: asrJobStatus('status').notNull().default('queued'),
        errorCode: text('error_code'),
        errorMessage: text('error_message'),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        completedAt: timestamp('completed_at', { withTimezone: true }),
        expiresAt: timestamp('expires_at', { withTimezone: true }),
    },
    (t) => [
        index('idx_asr_jobs_status_created_at').on(t.status, t.createdAt),
        index('idx_asr_jobs_expires_at').on(t.expiresAt),
        // Unique partial index handled via raw SQL migration (media_hash, model_version) where status='done'
    ]
);

export const asrArtifacts = pgTable(
    'asr_artifacts',
    {
        asrJobId: uuid('asr_job_id')
            .notNull()
            .references(() => asrJobs.id, { onDelete: 'cascade' }),
        kind: text('kind').notNull(), // srt | text | json
        storageKey: text('storage_key').notNull(),
        sizeBytes: integer('size_bytes'),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
    },
    (t) => [primaryKey({ columns: [t.asrJobId, t.kind] })]
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobEvent = typeof jobEvents.$inferSelect;
export type NewJobEvent = typeof jobEvents.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type AsrJob = typeof asrJobs.$inferSelect;
export type NewAsrJob = typeof asrJobs.$inferInsert;
export type AsrArtifact = typeof asrArtifacts.$inferSelect;
export type NewAsrArtifact = typeof asrArtifacts.$inferInsert;
