#!/usr/bin/env bun
/**
 * One-off backfill: set expires_at for jobs lacking a value.
 * Usage: bun run src/data/scripts/backfill-expires.ts
 */
import { createDb } from '../db/connection';
import { jobs } from '../db/schema';
import { isNull, eq } from 'drizzle-orm';

const RETENTION_HOURS = Number(process.env.RETENTION_HOURS || 72);

async function main() {
    const db = createDb();
    const now = Date.now();
    const rows = await db.select().from(jobs).where(isNull(jobs.expiresAt));
    let updated = 0;
    for (const r of rows) {
        const created = (r.createdAt as Date) ?? new Date();
        const expires = new Date(
            created.getTime() + RETENTION_HOURS * 3600_000
        );
        await db
            .update(jobs)
            .set({ expiresAt: expires })
            .where(eq(jobs.id, r.id));
        updated++;
    }
    console.log(JSON.stringify({ scanned: rows.length, updated }, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
