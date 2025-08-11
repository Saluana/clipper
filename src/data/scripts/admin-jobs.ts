import { eq, inArray } from 'drizzle-orm';
import { createDb } from '../db/connection';
import { jobs } from '../db/schema';
import { readEnv } from '@clipper/common';

type CloneCandidate = {
    id: string;
    status: string;
    sourceType: 'upload' | 'youtube';
    sourceKey: string | null;
    sourceUrl: string | null;
    startSec: number;
    endSec: number;
    withSubtitles: boolean;
    burnSubtitles: boolean;
    subtitleLang: string | null;
};

async function main() {
    // Inputs
    const argIds = process.argv.slice(2).filter(Boolean);
    const envIds = (readEnv('JOB_IDS') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const ids = (argIds.length ? argIds : envIds).filter(
        (v, i, a) => a.indexOf(v) === i
    );
    if (ids.length === 0) {
        console.error(
            'Usage: bun src/scripts/admin-jobs.ts <jobId...>\n  or: JOB_IDS="id1,id2" bun src/scripts/admin-jobs.ts'
        );
        process.exit(1);
    }
    const REQUEUE = (readEnv('REQUEUE') || 'true').toLowerCase() !== 'false';

    const db = createDb();

    // Fetch rows first (to know what to clone)
    const rows =
        ids.length === 1
            ? await db.select().from(jobs).where(eq(jobs.id, ids[0]!))
            : await db
                  .select()
                  .from(jobs)
                  .where(inArray(jobs.id, ids as string[]));

    if (rows.length === 0) {
        console.warn('[admin-jobs] No matching jobs found for provided IDs');
    }

    // Pick the first youtube job among the set as the clone candidate (if any)
    const yt: CloneCandidate | undefined = rows
        .map((r) => ({
            id: r.id,
            status: r.status,
            sourceType: r.sourceType,
            sourceKey: r.sourceKey,
            sourceUrl: r.sourceUrl,
            startSec: r.startSec,
            endSec: r.endSec,
            withSubtitles: r.withSubtitles,
            burnSubtitles: r.burnSubtitles,
            subtitleLang: r.subtitleLang,
        }))
        .find((r) => r.sourceType === 'youtube');

    // Delete all requested jobs; job_events cascades on delete
    const delCount = await db
        .delete(jobs)
        .where(
            ids.length === 1
                ? eq(jobs.id, ids[0]!)
                : inArray(jobs.id, ids as string[])
        );

    console.log('[admin-jobs] Deleted jobs', { ids, delCount });

    // Optionally requeue the youtube job by cloning its fields into a fresh row
    if (REQUEUE && yt) {
        const newId = crypto.randomUUID();
        const createdRows = await db
            .insert(jobs)
            .values({
                id: newId,
                status: 'queued',
                progress: 0,
                sourceType: 'youtube',
                sourceKey: yt.sourceKey,
                sourceUrl: yt.sourceUrl,
                startSec: yt.startSec,
                endSec: yt.endSec,
                withSubtitles: yt.withSubtitles,
                burnSubtitles: yt.burnSubtitles,
                subtitleLang: yt.subtitleLang,
                resultVideoKey: null,
                resultSrtKey: null,
                errorCode: null,
                errorMessage: null,
            })
            .returning();
        const created = createdRows[0]!;
        console.log('[admin-jobs] Requeued YouTube job', {
            oldId: yt.id,
            newId: created.id,
            sourceUrl: created.sourceUrl,
        });
    } else if (!yt) {
        console.log('[admin-jobs] No YouTube job among deleted IDs to requeue');
    } else {
        console.log('[admin-jobs] REQUEUE=false; skipping requeue');
    }
}

if (import.meta.main) {
    main().catch((err) => {
        console.error('[admin-jobs] Failed', err);
        process.exit(1);
    });
}
