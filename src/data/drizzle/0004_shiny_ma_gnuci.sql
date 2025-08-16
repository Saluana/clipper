ALTER TABLE "asr_jobs" ALTER COLUMN "max_attempts" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "max_attempts" DROP NOT NULL;