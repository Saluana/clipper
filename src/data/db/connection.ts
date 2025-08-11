import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { readEnv } from '@clipper/common';

export type DB = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(url = readEnv('DATABASE_URL')): DB {
    if (!url) {
        throw new Error('DATABASE_URL is required');
    }
    const pool = new Pool({ connectionString: url });
    return drizzle(pool, { schema });
}
