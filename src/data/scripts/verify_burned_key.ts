import { createDb } from '../db/connection';
import { sql } from 'drizzle-orm';

const db = createDb();

async function main() {
    try {
        const rows: any = await db.execute(
            sql`SELECT column_name FROM information_schema.columns WHERE table_name='jobs' AND column_name='result_video_burned_key'`
        );
        const found = Array.isArray(rows?.rows)
            ? rows.rows.length > 0
            : Array.isArray(rows)
            ? rows.length > 0
            : !!rows;
        console.log(JSON.stringify({ ok: true, columnPresent: found }));
    } catch (e) {
        console.error(JSON.stringify({ ok: false, error: String(e) }));
        process.exit(1);
    }
}

main();
