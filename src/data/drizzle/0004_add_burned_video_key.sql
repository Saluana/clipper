-- Add optional burned video key column to jobs
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "result_video_burned_key" text;
