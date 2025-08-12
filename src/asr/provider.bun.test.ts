import { describe, test, expect, beforeEach } from 'vitest';
import { GroqWhisperProvider, ProviderHttpError } from './provider';

// Helper to mock fetch
function mockFetchSequence(
    responses: Array<() => Promise<Response> | Response>
) {
    let i = 0;
    // @ts-ignore
    global.fetch = async (_url?: any, init?: RequestInit) => {
        if (i >= responses.length)
            throw new Error('fetch called too many times');
        const fn = responses[i++];
        const bodyPromise = Promise.resolve(
            typeof fn === 'function' ? (fn as any)() : fn
        );
        const signal = (init as any)?.signal as AbortSignal | undefined;
        if (!signal) return await bodyPromise;
        if (signal.aborted) {
            const err: any = new Error('Aborted');
            err.name = 'AbortError';
            throw err;
        }
        const abortPromise = new Promise<Response>((_resolve, reject) => {
            const onAbort = () => {
                const err: any = new Error('Aborted');
                err.name = 'AbortError';
                reject(err);
            };
            signal.addEventListener('abort', onAbort, { once: true });
        });
        return await Promise.race([bodyPromise, abortPromise]);
    };
}

describe('GroqWhisperProvider', () => {
    const apiKey = 'test_key';
    const tmpFile = `./tmp-test-audio-${Date.now()}.wav`;
    beforeEach(async () => {
        const data = new Uint8Array([0]);
        await Bun.write(tmpFile, data);
    });

    test('successful transcription maps segments', async () => {
        const json = {
            language: 'en',
            model: 'whisper-large-v3-turbo',
            segments: [
                {
                    start: 0,
                    end: 1.2,
                    text: ' Hello world ',
                    words: [{ start: 0, end: 0.5, word: 'Hello' }],
                },
                { start: 1.2, end: 2.0, text: 'Test' },
            ],
        };
        mockFetchSequence([
            async () =>
                new Response(JSON.stringify(json), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
        ]);
        const provider = new GroqWhisperProvider({ apiKey });
        const res = await provider.transcribe(tmpFile, { timeoutMs: 5000 });
        expect(res.segments.length).toBe(2);
        expect(res.segments[0]!.text).toBe('Hello world');
        expect(res.detectedLanguage).toBe('en');
        expect(res.durationSec).toBeCloseTo(2.0, 2);
    });

    test('retries on 500 then succeeds', async () => {
        const json = {
            language: 'en',
            model: 'whisper-large-v3-turbo',
            segments: [],
        };
        mockFetchSequence([
            async () => new Response('boom', { status: 500 }),
            async () => new Response(JSON.stringify(json), { status: 200 }),
        ]);
        const provider = new GroqWhisperProvider({
            apiKey,
            initialBackoffMs: 10,
            maxBackoffMs: 20,
        });
        const res = await provider.transcribe(tmpFile, { timeoutMs: 5000 });
        expect(res.segments.length).toBe(0);
    });

    test('stops after max retries and throws ProviderHttpError', async () => {
        mockFetchSequence([
            async () => new Response('e1', { status: 500 }),
            async () => new Response('e2', { status: 502 }),
            async () => new Response('e3', { status: 503 }),
        ]);
        const provider = new GroqWhisperProvider({
            apiKey,
            maxRetries: 2,
            initialBackoffMs: 5,
            maxBackoffMs: 10,
        });
        await expect(
            provider.transcribe(tmpFile, { timeoutMs: 2000 })
        ).rejects.toBeInstanceOf(ProviderHttpError);
    });

    test('abort signals cancel request', async () => {
        mockFetchSequence([
            () =>
                new Promise<Response>((_resolve, _reject) => {
                    // never resolves before abort
                }),
        ]);
        const provider = new GroqWhisperProvider({ apiKey });
        const controller = new AbortController();
        const p = provider.transcribe(tmpFile, {
            timeoutMs: 10_000,
            signal: controller.signal,
        });
        controller.abort();
        await expect(p).rejects.toHaveProperty('name', 'AbortError');
    });

    test('timeout triggers abort', async () => {
        mockFetchSequence([
            () =>
                new Promise<Response>((_resolve, _reject) => {
                    // never resolves (simulate hang)
                }),
        ]);
        const provider = new GroqWhisperProvider({ apiKey });
        await expect(
            provider.transcribe(tmpFile, { timeoutMs: 50 })
        ).rejects.toHaveProperty('name', 'AbortError');
    });
});
