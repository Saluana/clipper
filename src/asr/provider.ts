export interface AsrProviderSegment {
    startSec: number;
    endSec: number;
    text: string;
    words?: Array<{ startSec: number; endSec: number; text: string }>;
}

export interface AsrProviderResult {
    segments: AsrProviderSegment[];
    detectedLanguage?: string;
    modelVersion: string;
    durationSec: number;
}

export interface AsrProvider {
    transcribe(
        filePath: string,
        opts: { timeoutMs: number; signal?: AbortSignal; languageHint?: string }
    ): Promise<AsrProviderResult>;
}

export class ProviderHttpError extends Error {
    constructor(public status: number, public body?: string) {
        super(`Provider HTTP ${status}`);
        this.name = 'ProviderHttpError';
    }
}

export interface GroqWhisperConfig {
    apiKey?: string;
    model?: string;
    endpoint?: string;
    maxRetries?: number; // number of retry attempts on retryable errors
    initialBackoffMs?: number;
    maxBackoffMs?: number;
}

export class GroqWhisperProvider {
    private readonly apiKey: string;
    private readonly model: string;
    private readonly endpoint: string;
    private readonly maxRetries: number;
    private readonly initialBackoffMs: number;
    private readonly maxBackoffMs: number;

    constructor(cfg: GroqWhisperConfig = {}) {
        const key = cfg.apiKey ?? process.env.GROQ_API_KEY ?? '';
        if (!key) throw new Error('GROQ_API_KEY not configured');
        this.apiKey = key;
        this.model =
            cfg.model ?? process.env.GROQ_MODEL ?? 'whisper-large-v3-turbo';
        this.endpoint =
            cfg.endpoint ??
            'https://api.groq.com/openai/v1/audio/transcriptions';
        this.maxRetries = cfg.maxRetries ?? 3;
        this.initialBackoffMs = cfg.initialBackoffMs ?? 200;
        this.maxBackoffMs = cfg.maxBackoffMs ?? 2000;
    }

    async transcribe(
        filePath: string,
        opts: { timeoutMs: number; signal?: AbortSignal; languageHint?: string }
    ): Promise<AsrProviderResult> {
        const { timeoutMs, signal, languageHint } = opts;

        const controller = new AbortController();
        const signals: AbortSignal[] = [controller.signal];
        if (signal) {
            if (signal.aborted) controller.abort();
            else
                signal.addEventListener('abort', () => controller.abort(), {
                    once: true,
                });
            signals.push(signal);
        }
        const timeout = setTimeout(
            () => controller.abort(),
            Math.max(1, timeoutMs)
        );
        try {
            return await this.requestWithRetry(
                filePath,
                languageHint,
                controller.signal
            );
        } finally {
            clearTimeout(timeout);
        }
    }

    private async requestWithRetry(
        filePath: string,
        languageHint: string | undefined,
        signal: AbortSignal
    ): Promise<AsrProviderResult> {
        let attempt = 0;
        let backoff = this.initialBackoffMs;
        // Prepare payload outside of loop? File object can be reused.
        const file = await this.buildFile(filePath);
        const form = new FormData();
        form.set('model', this.model);
        form.set('response_format', 'verbose_json');
        if (languageHint && languageHint !== 'auto')
            form.set('language', languageHint);
        form.set('file', file);

        // Clone-able body for retries? FormData can be re-sent in Bun; if not, rebuild per attempt.
        const buildBody = async () => {
            // Rebuild to be safe for multiple attempts
            const f = await this.buildFile(filePath);
            const fd = new FormData();
            fd.set('model', this.model);
            fd.set('response_format', 'verbose_json');
            if (languageHint && languageHint !== 'auto')
                fd.set('language', languageHint);
            fd.set('file', f);
            return fd;
        };

        // Retry loop
        // eslint-disable-next-line no-constant-condition
        while (true) {
            try {
                const res = await fetch(this.endpoint, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                    },
                    body: attempt === 0 ? form : await buildBody(),
                    signal,
                });

                if (!res.ok) {
                    if (this.isRetryable(res.status)) {
                        attempt++;
                        if (attempt > this.maxRetries) {
                            throw new ProviderHttpError(
                                res.status,
                                await GroqWhisperProvider.safeText(res)
                            );
                        }
                        const retryAfter = this.parseRetryAfter(
                            res.headers.get('retry-after')
                        );
                        const wait = Math.min(
                            Math.max(retryAfter ?? backoff, 0),
                            this.maxBackoffMs
                        );
                        await GroqWhisperProvider.sleep(wait);
                        backoff = Math.min(backoff * 2, this.maxBackoffMs);
                        continue;
                    }
                    throw new ProviderHttpError(
                        res.status,
                        await GroqWhisperProvider.safeText(res)
                    );
                }

                const json: any = await res.json();
                return this.mapVerboseJson(json);
            } catch (err: any) {
                // Network or abort
                if (err?.name === 'AbortError') throw err;
                attempt++;
                if (attempt > this.maxRetries) {
                    if (err instanceof ProviderHttpError) throw err;
                    throw new ProviderHttpError(0, String(err?.message ?? err));
                }
                const wait = Math.min(backoff, this.maxBackoffMs);
                await GroqWhisperProvider.sleep(wait);
                backoff = Math.min(backoff * 2, this.maxBackoffMs);
            }
        }
    }

    private mapVerboseJson(json: any): AsrProviderResult {
        const segments: AsrProviderSegment[] = Array.isArray(json?.segments)
            ? json.segments.map((s: any) => ({
                  startSec: Number(s.start) || 0,
                  endSec: Number(s.end) || 0,
                  text: String(s.text ?? '')
                      .trim()
                      .replace(/\s+/g, ' '),
                  words: Array.isArray(s.words)
                      ? s.words.map((w: any) => ({
                            startSec: Number(w.start) || 0,
                            endSec: Number(w.end) || 0,
                            text: String(w.word ?? '').trim(),
                        }))
                      : undefined,
              }))
            : [];

        const durationSec = segments.length
            ? segments[segments.length - 1]!.endSec
            : 0;
        return {
            segments,
            detectedLanguage: json?.language,
            modelVersion: json?.model ?? this.model,
            durationSec,
        };
    }

    private async buildFile(filePath: string): Promise<File> {
        const bf = Bun.file(filePath);
        const ab = await bf.arrayBuffer();
        const name = filePath.split('/').pop() || 'audio';
        return new File([ab], name);
    }

    private isRetryable(status: number): boolean {
        return status === 429 || (status >= 500 && status <= 599);
    }

    private parseRetryAfter(val: string | null): number | null {
        if (!val) return null;
        const s = Number(val);
        return Number.isFinite(s) ? Math.max(0, Math.floor(s * 1000)) : null;
    }

    static async safeText(res: Response): Promise<string | undefined> {
        try {
            const t = await res.text();
            // minimal redaction (avoid echoing tokens if ever present)
            return t.replace(/(api|bearer)\s+[a-z0-9-_]+/gi, '$1 ***');
        } catch {
            return undefined;
        }
    }

    static sleep(ms: number) {
        return new Promise((r) => setTimeout(r, ms));
    }
}
