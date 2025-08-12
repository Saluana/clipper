-- Wrapped enum creations in DO blocks for idempotence. If the type already
-- exists (e.g. database reused between runs), the duplicate_object exception
-- is swallowed so the migration can proceed. NOTE: This does NOT reconcile
-- differences in enum members; if you need to add new values later, create a
-- new migration using ALTER TYPE ... ADD VALUE.
DO $$ BEGIN
	CREATE TYPE "public"."job_status" AS ENUM('queued', 'processing', 'done', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."source_type" AS ENUM('upload', 'youtube');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_events" (
	"job_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"source_type" "source_type" NOT NULL,
	"source_key" text,
	"source_url" text,
	"start_sec" integer NOT NULL,
	"end_sec" integer NOT NULL,
	"with_subtitles" boolean DEFAULT false NOT NULL,
	"burn_subtitles" boolean DEFAULT false NOT NULL,
	"subtitle_lang" text,
	"result_video_key" text,
	"result_srt_key" text,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_job_events_job_id_ts" ON "job_events" USING btree ("job_id","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jobs_status_created_at" ON "jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jobs_expires_at" ON "jobs" USING btree ("expires_at");