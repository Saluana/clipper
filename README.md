# clipper

High‑performance media clipping pipeline (upload → clip (FFmpeg) → store → status/result API) built on Bun, Postgres (Drizzle), pg-boss, and Supabase Storage.

## ✨ Features (Current Layer Status)

| Layer              | Status      | Notes                                                  |
| ------------------ | ----------- | ------------------------------------------------------ |
| 0 Foundations      | ✅          | Types, schemas, logger, errors, time utils             |
| 1 Data Layer       | ✅          | Drizzle schema + repos                                 |
| 2 Queue Layer      | ✅          | pg-boss adapter + DLQ consumer skeleton                |
| 3 Media IO         | ✅          | Upload + YouTube (gated) resolvers with SSRF guard     |
| 4 FFmpeg Clipper   | ✅          | Stream-copy + fallback re-encode with progress         |
| 5 ASR (Whisper)    | ⏳          | Planned                                                |
| 6 Worker Runtime   | ✅ (basic)  | Integrated clipper & progress persistence              |
| 7 API              | 🚧          | Create job present; status/result endpoints upcoming   |
| 8 Storage Delivery | Partial     | Upload result video wired; signed result retrieval TBD |
| 9 Cleanup          | ✅          | TTL cleanup script                                     |
| 10 Observability   | Minimal     | Basic logging; metrics TODO                            |
| 11 Security        | Minimal     | Redaction + SSRF allowlist; rate limiting TBD          |
| 12 Docs / SDK      | In Progress | This README + more docs being added                    |
| 13 UI              | Planned     | Simple demo page                                       |

## 🧩 Architecture (High Level Flow)

1. Client submits job (upload source key or YouTube URL + time range).
2. API persists job (status=queued) → enqueues message.
3. Worker consumes job → resolves source locally → runs FFmpeg clipper (progress streamed) → uploads result → marks done.
4. Client polls /jobs/:id (status + progress) and later fetches signed result URL.

## ⚙️ Requirements

You need these installed locally:

-   Bun >= 1.2.x
-   ffmpeg & ffprobe in PATH
-   Postgres (or Supabase) reachable via `DATABASE_URL`

Optional:

-   yt-dlp (if enabling YouTube resolver via `ENABLE_YTDLP=true`)

## 🚀 Quick Start

```bash
# 1. Install deps
bun install

# 2. Copy & edit environment
cp .env.example .env
# Fill in DATABASE_URL, SUPABASE_* values, etc.

# 3. Run migrations (drizzle-kit configured)
# (Add migration command here when generated) – schema currently bootstrap via SQL file.

# 4. Start API (once endpoints added) & worker in separate terminals
bun run src/api/index.ts &
bun run src/worker/index.ts
```

## 🔑 Key Environment Variables

| Var                                      | Purpose                                         | debug | info | warn  | error |
| ---------------------------------------- | ----------------------------------------------- | ----- | ---- | ----- | ----- |
| DATABASE_URL                             | Postgres / pg-boss + Drizzle                    |
| SCRATCH_DIR                              | Local fast storage for source + clip temp files |
| SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY | Storage access                                  |
| SUPABASE_STORAGE_BUCKET                  | Bucket with sources/results prefixes            |
| ENABLE_YTDLP                             | Enable YouTube resolver                         |
| MAX_CLIP_INPUT_DURATION_SEC              | Guardrail on input length                       |
| MAX_INPUT_MB                             | Guardrail on input file size                    |
| SIGNED_URL_TTL_SEC                       | TTL for signed result URLs                      |
| LOG_LEVEL                                | debug                                           | info  | warn | error |

See `.env.example` for the complete list.

## 🎬 FFmpeg Clipper

Fast path attempts `-ss -to -c copy -movflags +faststart`. If container/keyframe layout prevents accurate copy or copy fails, it falls back to `libx264 + aac (veryfast)` ensuring a valid playable MP4. Progress is parsed from `-progress pipe:1` output and persisted to the DB in the worker with lightweight debouncing.

## 📦 Storage Layout

```
sources/{jobId}/source.ext
results/{jobId}/clip.mp4
results/{jobId}/clip.srt (future)
```

## 🧪 Testing

Unit & integration tests (vitest):

```bash
bunx vitest
```

FFmpeg integration tests polyfill Bun globals when run under vitest’s Node environment. Ensure ffmpeg/ffprobe exist for those tests.

## 🛠 Development Tips

-   Use `LOG_LEVEL=debug` while iterating on worker features.
-   Clip accuracy: if users report off-by drift in copy mode, fallback re-encode path guarantees frame-accurate boundaries.
-   Add new job lifecycle events via `events.add({ type, data })` for richer status endpoints.

## 🔒 Security Notes

-   SSRF guard + allowlist enforced for YouTube URLs.
-   Secrets redacted in logs (see `redact.ts`).
-   Future: API keys, rate limits.

## 📘 Next Work

1. Expose GET /api/jobs/:id + /api/jobs/:id/result
2. Signed URL issuance for results
3. Basic metrics (progress histograms, queue depth)
4. Whisper ASR integration

## 📝 License

Currently unspecified (internal / WIP). Add an OSS license before public release.

---

Generated with ❤️ using Bun.
