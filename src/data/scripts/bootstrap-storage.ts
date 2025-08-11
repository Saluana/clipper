import { createClient } from '@supabase/supabase-js';
import { readEnv } from '@clipper/common';

export type BootstrapOptions = {
    url?: string;
    serviceRoleKey?: string;
    bucket: string;
    createPrefixes?: boolean; // creates sources/.keep and results/.keep
};

export async function bootstrapStorage(opts: BootstrapOptions) {
    const url = opts.url ?? readEnv('SUPABASE_URL');
    const key = opts.serviceRoleKey ?? readEnv('SUPABASE_SERVICE_ROLE_KEY');
    const bucket = opts.bucket;
    if (!url || !key) throw new Error('Missing SUPABASE_URL or SERVICE_ROLE');
    if (!bucket) throw new Error('Missing bucket name');

    const supabase = createClient(url, key);

    // Ensure bucket exists
    const { data: buckets, error: listErr } =
        await supabase.storage.listBuckets();
    if (listErr) throw new Error(`listBuckets failed: ${listErr.message}`);
    const exists = (buckets ?? []).some((b) => b.name === bucket);
    if (!exists) {
        const { error } = await supabase.storage.createBucket(bucket, {
            public: false,
        });
        if (error && !String(error.message).includes('already exists')) {
            throw new Error(`createBucket failed: ${error.message}`);
        }
    }

    // Optionally create prefix keep files
    if (opts.createPrefixes) {
        const mk = async (path: string) =>
            supabase.storage
                .from(bucket)
                .upload(path, new Blob([new Uint8Array(0)]), {
                    upsert: true,
                    contentType: 'application/octet-stream',
                })
                .then(({ error }) => {
                    if (
                        error &&
                        !String(error.message).includes('already exists')
                    )
                        throw new Error(
                            `upload ${path} failed: ${error.message}`
                        );
                });
        await mk('sources/.keep');
        await mk('results/.keep');
    }
}

// CLI entry
if (import.meta.main) {
    const bucket = readEnv('SUPABASE_STORAGE_BUCKET');
    bootstrapStorage({
        bucket: bucket!,
        createPrefixes: true,
    })
        .then(() => {
            console.log('Storage bootstrap complete');
        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
