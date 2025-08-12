-- Add last_heartbeat_at column to jobs
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "last_heartbeat_at" timestamp with time zone;
-- Index could be added later if querying stale heartbeats frequently
