# Clipper API Reference

Base URL: `http://localhost:3000` (override with `PORT`).
If `ENABLE_API_KEYS=true`, include either `Authorization: Bearer <key>` or `x-api-key: <key>`.
Send an optional `x-request-id` to correlate logs; returned as `correlationId`.

---

## Conventions

-   Timecodes: `HH:MM:SS` or `HH:MM:SS.mmm` (milliseconds optional).
-   All responses: JSON.
-   Errors: unified envelope.

### Error Envelope

```
{
  "error": { "code": "STRING", "message": "Text", "correlationId": "id" }
}
```

Common codes: `VALIDATION_FAILED`, `NOT_FOUND`, `NOT_READY`, `GONE`, `UNAUTHORIZED`, `RATE_LIMITED`, `INTERNAL`, plus worker surface codes like `YTDLP_*`, `INPUT_TOO_LARGE`, `STORAGE_UPLOAD_FAILED:*`, `CLIP_TIMEOUT`.

---

## Create Clip Job

POST `/api/jobs`

Create a clipping job from an uploaded source object or a YouTube URL.

Request Body:

```
{
  "sourceType": "upload" | "youtube",
  "uploadKey": "sources/<id>/source.mp4",      // required when sourceType=upload
  "youtubeUrl": "https://www.youtube.com/...", // required when sourceType=youtube
  "start": "HH:MM:SS[.mmm]",                   // inclusive start
  "end":   "HH:MM:SS[.mmm]",                   // exclusive end (> start)
  "withSubtitles": false,                       // request ASR transcription
  "burnSubtitles": false,                       // burn subtitles (if withSubtitles)
  "subtitleLang": "auto" | "en" | <langCode>   // optional
}
```

Constraints:

-   `end - start <= MAX_CLIP_SECONDS` (env, default 120)
-   YouTube URL must pass allowlist + SSRF checks
-   File / source size & duration must satisfy `MAX_INPUT_MB`, `MAX_CLIP_INPUT_DURATION_SEC`

200 Response:

```
{
  "correlationId": "...",
  "job": { "id": "uuid", "status": "queued", "progress": 0, "expiresAt": "ISO" }
}
```

Errors: 400 `VALIDATION_FAILED` or `CLIP_TOO_LONG`; 401 `UNAUTHORIZED`; 429 `RATE_LIMITED`.

---

## Get Job Status

GET `/api/jobs/{id}`

200 Response:

```
{
  "correlationId": "...",
  "job": {
    "id": "uuid",
    "status": "queued" | "processing" | "done" | "failed",
    "progress": 0-100,
  "resultVideoKey": "results/<id>/clip.mp4"?,
  "resultVideoBurnedKey": "results/<id>/clip.subbed.mp4"?,
    "resultSrtKey": "results/<id>/clip.srt"?,
    "expiresAt": "ISO"?
  },
  "events": [
    { "ts": "ISO", "type": "created" },
    { "ts": "ISO", "type": "processing" },
    { "ts": "ISO", "type": "source:ready", "data": { "durationSec": 900.1 } },
    { "ts": "ISO", "type": "progress", "data": { "pct": 42, "stage": "clip" } },
    { "ts": "ISO", "type": "uploaded", "data": { "key": "results/<id>/clip.mp4" } },
    { "ts": "ISO", "type": "asr:requested", "data": { "asrJobId": "..." } },
    { "ts": "ISO", "type": "asr:error", "data": { "err": "..." } },
    { "ts": "ISO", "type": "done" | "failed" }
  ]
}
```

Errors: 404 `NOT_FOUND`; 410 `GONE` (expired).

---

## Get Job Result

GET `/api/jobs/{id}/result`

200 Response (only when job done):

```
{
  "correlationId": "...",
  "result": {
    "id": "uuid",
    "video": { "key": "results/<id>/clip.mp4", "url": "signedUrl" },
    "burnedVideo": { "key": "results/<id>/clip.subbed.mp4", "url": "signedUrl" }?,
    "srt": { "key": "results/<id>/clip.srt", "url": "signedUrl" }?
  }
}
```

Errors: 404 `NOT_READY` (not done yet); 404 `NOT_FOUND`; 410 `GONE`; 500 `STORAGE_UNAVAILABLE`.

---

## Health

GET `/healthz`

```
{ "ok": true, "queue": { ... }, "correlationId": "..." }
```

---

## Metrics

GET `/metrics` -> in‑memory metrics snapshot.
GET `/metrics/queue` -> queue depth & timings.

---

## Events (Types)

`created`, `processing`, `source:ready`, `progress`, `uploaded`, `asr:requested`, `asr:error`, `failed`, `done`.

---

## Lifecycle

```
queued -> processing -> (done | failed)
```

Heartbeats update `lastHeartbeatAt` internally.

---

## Storage Keys

```
results/{jobId}/clip.mp4
results/{jobId}/clip.subbed.mp4
results/{jobId}/clip.srt (ASR)
```

---

## Worker Pass-through Error Codes

`YTDLP_NOT_FOUND`, `YTDLP_TIMEOUT`, `YTDLP_DISABLED`, `YTDLP_FAILED:<n>`, `INPUT_TOO_LARGE`, `FFPROBE_FAILED`, `STORAGE_UPLOAD_FAILED:<msg>`, `CLIP_TIMEOUT`, `BAD_REQUEST` (ffmpeg failures).

---

## Core Environment Variables

| Var                                                                | Description                   |
| ------------------------------------------------------------------ | ----------------------------- | ---- | ---- | ----- |
| PORT                                                               | API port (3000)               |
| DATABASE_URL                                                       | Postgres (Drizzle + pg-boss)  |
| SCRATCH_DIR                                                        | Temp space for sources/clips  |
| SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_STORAGE_BUCKET | Storage config                |
| ENABLE_YTDLP                                                       | Enable YouTube resolver       |
| MAX_INPUT_MB                                                       | Max source size (MB)          |
| MAX_CLIP_INPUT_DURATION_SEC                                        | Max source duration (s)       |
| MAX_CLIP_SECONDS                                                   | Max requested clip length (s) |
| SIGNED_URL_TTL_SEC                                                 | Signed URL lifetime           |
| LOG_LEVEL                                                          | debug                         | info | warn | error |
| ENABLE_API_KEYS                                                    | Require API keys              |
| RATE_LIMIT_WINDOW_SEC / RATE_LIMIT_MAX                             | Rate limiting                 |
| STORAGE_UPLOAD_ATTEMPTS                                            | Upload retry attempts         |
| YTDLP_FORMAT / YTDLP_SECTIONS                                      | yt-dlp override/sections      |

---

## Curl Examples

Create YouTube job:

```
curl -X POST http://localhost:3000/api/jobs \
 -H 'Content-Type: application/json' \
 -d '{"sourceType":"youtube","youtubeUrl":"https://www.youtube.com/watch?v=VIDEO","start":"00:01:00","end":"00:01:25","withSubtitles":false}'
```

Poll status:

```
curl http://localhost:3000/api/jobs/<jobId>
```

Fetch result:

```
curl http://localhost:3000/api/jobs/<jobId>/result
```
