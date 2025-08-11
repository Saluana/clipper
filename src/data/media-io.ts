export interface ResolveResult {
    localPath: string;
    cleanup: () => Promise<void>;
    meta: { durationSec: number; sizeBytes: number; container?: string };
}

export interface SourceResolver {
    resolve(job: {
        id: string;
        sourceType: 'upload' | 'youtube';
        sourceKey?: string; // Supabase path (for uploads)
        sourceUrl?: string; // External URL (YouTube)
    }): Promise<ResolveResult>;
}
