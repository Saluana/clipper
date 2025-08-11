import { describe, it, expect } from 'vitest';
import { resolveYouTubeSource } from '../media-io-youtube';

const oldEnv = { ...process.env };

function withEnv(
    vars: Record<string, string | undefined>,
    fn: () => Promise<void>
) {
    return async () => {
        process.env = { ...oldEnv, ...vars } as any;
        try {
            await fn();
        } finally {
            process.env = oldEnv as any;
        }
    };
}

describe('YouTube resolver (gated)', () => {
    it(
        'rejects when ENABLE_YTDLP is not true',
        withEnv({ ENABLE_YTDLP: 'false' }, async () => {
            await expect(
                resolveYouTubeSource({
                    id: 'job1',
                    sourceType: 'youtube',
                    sourceUrl: 'https://example.com/watch?v=abc',
                })
            ).rejects.toThrowError(/YTDLP_DISABLED/);
        })
    );
});

describe('SSRF guard', () => {
    it(
        'blocks private IP hostnames',
        withEnv({ ENABLE_YTDLP: 'true' }, async () => {
            await expect(
                resolveYouTubeSource({
                    id: 'job2',
                    sourceType: 'youtube',
                    sourceUrl: 'http://127.0.0.1/video',
                })
            ).rejects.toThrowError(/SSRF_BLOCKED/);
        })
    );

    it(
        'blocks non-http scheme',
        withEnv({ ENABLE_YTDLP: 'true' }, async () => {
            await expect(
                resolveYouTubeSource({
                    id: 'job3',
                    sourceType: 'youtube',
                    sourceUrl: 'file:///etc/passwd',
                })
            ).rejects.toThrowError(/SSRF_BLOCKED/);
        })
    );

    it(
        'blocks disallowed host when allowlist present',
        withEnv(
            { ENABLE_YTDLP: 'true', ALLOWLIST_HOSTS: 'youtube.com' },
            async () => {
                await expect(
                    resolveYouTubeSource({
                        id: 'job4',
                        sourceType: 'youtube',
                        sourceUrl: 'https://vimeo.com/1',
                    })
                ).rejects.toThrowError(/SSRF_BLOCKED/);
            }
        )
    );
});
