ALTER TABLE "asr_jobs" ADD COLUMN "locked_by" text;--> statement-breakpoint
ALTER TABLE "asr_jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "asr_jobs" ADD COLUMN "last_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "asr_jobs" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "asr_jobs" ADD COLUMN "max_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "asr_jobs" ADD COLUMN "fail_code" text;--> statement-breakpoint
ALTER TABLE "asr_jobs" ADD COLUMN "fail_reason" text;--> statement-breakpoint
ALTER TABLE "asr_jobs" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "asr_jobs" ADD COLUMN "next_earliest_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "asr_jobs" ADD COLUMN "expected_duration_ms" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "locked_by" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "max_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "fail_code" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "fail_reason" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "next_earliest_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "expected_duration_ms" integer;--> statement-breakpoint
CREATE INDEX "idx_asr_jobs_status_lease" ON "asr_jobs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_jobs_status_lease" ON "jobs" USING btree ("status","lease_expires_at");