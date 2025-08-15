# Clipper Tutorial / Quick Guide

This guide walks you from zero to a clipped video using the Clipper API + worker.

---

## 1. Install & Configure

```
bun install
cp .env.example .env
# Edit .env: DATABASE_URL=..., SUPABASE_*, ENABLE_YTDLP=true (for YouTube)
```

Ensure `ffmpeg`, `ffprobe`, and optionally `yt-dlp` are installed and in PATH.

Run migrations:

```
bun run db:migrate
```

---

## 2. Start Services

In two terminals:

```
bun run dev        # API
bun run dev:worker # Worker
```

Set `LOG_LEVEL=debug` temporarily for deeper logs.

Check health:

```
curl http://localhost:3000/healthz
```

Expect `{ "ok": true, ... }`.

---

## 3. Create a YouTube Clip Job

Pick a short segment. Example: 25 seconds starting at 1 minute.

```
curl -X POST http://localhost:3000/api/jobs \
 -H 'Content-Type: application/json' \
 -d '{"sourceType":"youtube","youtubeUrl":"https://www.youtube.com/watch?v=VIDEO","start":"00:01:00","end":"00:01:25","withSubtitles":false}'
```

Response includes the `job.id`.

If using API keys (`ENABLE_API_KEYS=true`):

```
-H 'Authorization: Bearer <your_key>'
```

---

## 4. Poll Job Status

```
JOB_ID=<uuid>
watch -n2 curl -s http://localhost:3000/api/jobs/$JOB_ID | jq .
```

You will see `status` change to `processing`, progress values, then `done`.

Events show lifecycle: `created`, `processing`, `source:ready`, periodic `progress`, `uploaded`, `done`.

Near‑zero duration handling: If your requested duration is below the configured minimum, the service can optionally coerce it up to a minimum window.

-   MIN_DURATION_SEC (default 0.5)
-   COERCE_MIN_DURATION (false by default). When true, end time is extended to meet MIN_DURATION_SEC.

If coercion is disabled and the duration is below the minimum, the request will be rejected by validation.

---

## 5. Fetch the Result

```
curl http://localhost:3000/api/jobs/$JOB_ID/result | jq .
```

Grab the signed `video.url` and download:

```
curl -L "<signedUrl>" -o clip.mp4
```

Play it to verify.

Error envelopes: When a job fails, the API returns a stable error shape:

```
{ "error": { "code": "...", "message": "...", "correlationId": "..." } }
```

Common codes:

-   OUTPUT_VERIFICATION_FAILED (422)
-   SOURCE_UNREADABLE (422)
-   RETRYABLE_ERROR (503)
-   RETRIES_EXHAUSTED (422)

---

## 6. Upload Source Workflow (Alternative)

Instead of YouTube, first upload a file to storage (e.g. via Supabase client) at a key like:

```
sources/<uuid>/source.mp4
```

Then create job:

```
curl -X POST http://localhost:3000/api/jobs \
 -H 'Content-Type: application/json' \
 -d '{"sourceType":"upload","uploadKey":"sources/<uuid>/source.mp4","start":"00:00:05","end":"00:00:12"}'
```

---

## 7. Subtitles

Set `withSubtitles:true` and (optionally) `subtitleLang:"auto"`.
Events will include `asr:requested` and later job status will gain `resultSrtKey`.
If `burnSubtitles:true`, a burned variant will upload under `results/{jobId}/clip.subbed.mp4`.
The result endpoint will include `burnedVideo` alongside `video` and optional `srt`.

---

## 8. Troubleshooting

| Symptom                      | Action                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `YTDLP_NOT_FOUND`            | Install `yt-dlp` or set `YTDLP_BIN` env path                                        |
| `INPUT_TOO_LARGE`            | Adjust `MAX_INPUT_MB` / download smaller format (`YTDLP_FORMAT`)                    |
| `OUTPUT_VERIFICATION_FAILED` | Ensure ffmpeg present; try enabling re-encode path (it’s automatic on copy failure) |
| `SOURCE_UNREADABLE`          | Input could not be probed/read. Verify file exists and is supported.                |
| Stuck at `queued`            | Ensure worker process running and queue connected (DATABASE_URL)                    |
| `STORAGE_UPLOAD_FAILED`      | Verify Supabase credentials & bucket; check object size limit                       |
| Wrong duration               | Re-encode fallback now auto-corrects; ensure ffmpeg in PATH                         |

View logs with `LOG_LEVEL=debug` for granular ffmpeg / yt-dlp details.

---

## 9. Cleaning Up

Expired jobs removed by cleanup scripts (if scheduled). You can manually delete scratch dir:

```
rm -rf ${SCRATCH_DIR:-/tmp/ytc}/sources/*
```

---

## 10. Extending

-   Add new events → update API docs.
-   Add metrics counters (use `metrics.observe` / `metrics.inc`).
-   Implement WebSocket push for progress (subscribe clients instead of polling).

---

Happy clipping!
