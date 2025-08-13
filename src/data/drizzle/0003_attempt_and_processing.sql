-- Migration: add attempt_count & processing_started_at + index on (status,last_heartbeat_at)
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "attempt_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "processing_started_at" timestamp with time zone;
-- Create index to accelerate stale heartbeat recovery scans
CREATE INDEX IF NOT EXISTS "idx_jobs_status_last_hb" ON "jobs" USING btree ("status","last_heartbeat_at");
