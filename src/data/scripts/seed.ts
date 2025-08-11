import { createDb } from '../db/connection';
import { jobs } from '../db/schema';

export async function seedMinimal() {
    const db = createDb();
    const id = crypto.randomUUID();
    await db.insert(jobs).values({
        id,
        status: 'queued',
        progress: 0,
        sourceType: 'upload',
        startSec: 0,
        endSec: 5,
        withSubtitles: false,
        burnSubtitles: false,
    });
    console.log('Seeded job:', id);
}

if (import.meta.main) {
    seedMinimal().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
