import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readEnv } from '../common/index';

export const storageKeys = {
    source: (jobId: string, ext: string) =>
        `sources/${jobId}/source.${ext.replace(/^\./, '')}`,
    resultVideo: (jobId: string) => `results/${jobId}/clip.mp4`,
    resultSrt: (jobId: string) => `results/${jobId}/clip.srt`,
};

export interface StorageRepo {
    upload(localPath: string, key: string, contentType?: string): Promise<void>;
    sign(key: string, ttlSec?: number): Promise<string>;
    remove(key: string): Promise<void>;
}

export type SupabaseStorageOptions = {
    url?: string;
    serviceRoleKey?: string;
    bucket?: string;
    defaultTtlSec?: number; // default 600 (10 minutes)
    client?: SupabaseClient; // optional injection for testing
};

export function createSupabaseStorageRepo(
    opts: SupabaseStorageOptions = {}
): StorageRepo {
    const url = opts.url ?? readEnv('SUPABASE_URL');
    const key = opts.serviceRoleKey ?? readEnv('SUPABASE_SERVICE_ROLE_KEY');
    const bucket = opts.bucket ?? readEnv('SUPABASE_STORAGE_BUCKET');
    const ttlStr = readEnv('SIGNED_URL_TTL_SEC');
    const defaultTtlSec = opts.defaultTtlSec ?? (ttlStr ? Number(ttlStr) : 600);

    if (!url || !key || !bucket) {
        throw new Error(
            'Supabase storage not configured: require SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET'
        );
    }

    const client = opts.client ?? createClient(url, key);
    return new SupabaseStorageRepo(client, bucket, defaultTtlSec);
}

class SupabaseStorageRepo implements StorageRepo {
    constructor(
        private readonly supabase: SupabaseClient,
        private readonly bucket: string,
        private readonly defaultTtlSec: number
    ) {}

    async upload(
        localPath: string,
        key: string,
        contentType?: string
    ): Promise<void> {
        const type = contentType ?? guessContentType(key);
        const bun: any = (globalThis as any).Bun;
        const forceNode = readEnv('FORCE_NODE_FS') === '1';
        let blob: Blob;
        if (!forceNode && bun?.file) {
            const file = bun.file(localPath);
            if (!(await file.exists())) {
                throw new Error(`FILE_NOT_FOUND: ${localPath}`);
            }
            blob = new Blob([await file.arrayBuffer()], { type });
        } else {
            const { readFile } = await import('node:fs/promises');
            const data = await readFile(localPath);
            blob = new Blob([data], { type });
        }
        const { error } = await this.supabase.storage
            .from(this.bucket)
            .upload(key, blob, { upsert: true, contentType: blob.type });
        if (error) throw new Error(`STORAGE_UPLOAD_FAILED: ${error.message}`);
    }

    async sign(key: string, ttlSec?: number): Promise<string> {
        const { data, error } = await this.supabase.storage
            .from(this.bucket)
            .createSignedUrl(key, ttlSec ?? this.defaultTtlSec);
        if (error || !data?.signedUrl)
            throw new Error(
                `STORAGE_SIGN_FAILED: ${error?.message ?? 'unknown'}`
            );
        return data.signedUrl;
    }

    async remove(key: string): Promise<void> {
        const { error } = await this.supabase.storage
            .from(this.bucket)
            .remove([key]);
        if (error) throw new Error(`STORAGE_REMOVE_FAILED: ${error.message}`);
    }
}

function guessContentType(key: string): string {
    const lower = key.toLowerCase();
    if (lower.endsWith('.mp4')) return 'video/mp4';
    if (lower.endsWith('.mkv')) return 'video/x-matroska';
    if (lower.endsWith('.mov')) return 'video/quicktime';
    if (lower.endsWith('.webm')) return 'video/webm';
    if (lower.endsWith('.srt')) return 'application/x-subrip';
    if (lower.endsWith('.txt')) return 'text/plain; charset=utf-8';
    if (lower.endsWith('.json')) return 'application/json';
    return 'application/octet-stream';
}
