-- ASR tables migration
CREATE TYPE "public"."asr_job_status" AS ENUM('queued','processing','done','failed');

CREATE TABLE "asr_jobs" (
    "id" uuid PRIMARY KEY NOT NULL,
    "clip_job_id" uuid,
    "source_type" text NOT NULL,
    "source_key" text,
    "media_hash" text NOT NULL,
    "model_version" text NOT NULL,
    "language_hint" text,
    "detected_language" text,
    "duration_sec" integer,
    "status" "asr_job_status" DEFAULT 'queued' NOT NULL,
    "error_code" text,
    "error_message" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    "completed_at" timestamp with time zone,
    "expires_at" timestamp with time zone
);
ALTER TABLE "asr_jobs" ADD CONSTRAINT "asr_jobs_clip_job_id_jobs_id_fk" FOREIGN KEY ("clip_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "idx_asr_jobs_status_created_at" ON "asr_jobs" USING btree ("status","created_at");
CREATE INDEX "idx_asr_jobs_expires_at" ON "asr_jobs" USING btree ("expires_at");
-- unique reuse index (partial)
CREATE UNIQUE INDEX "uq_asr_jobs_media_model_done" ON "asr_jobs" ("media_hash","model_version") WHERE status = 'done';

CREATE TABLE "asr_artifacts" (
    "asr_job_id" uuid NOT NULL,
    "kind" text NOT NULL,
    "storage_key" text NOT NULL,
    "size_bytes" integer,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT asr_artifacts_pk PRIMARY KEY ("asr_job_id","kind"),
    CONSTRAINT asr_artifacts_asr_job_id_asr_jobs_id_fk FOREIGN KEY ("asr_job_id") REFERENCES "public"."asr_jobs"("id") ON DELETE cascade ON UPDATE no action
);
