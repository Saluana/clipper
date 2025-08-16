# Clipper REST API — Quickstart Guide

Base URL: http://localhost:3000 (override with PORT)

-   OpenAPI JSON: GET /openapi.json (set ENABLE_OPENAPI=true)
-   Content type: application/json
-   Auth: If API keys are enabled, send either Authorization: Bearer <key> or x-api-key: <key>

---

## Endpoints at a glance

-   GET /healthz — Health probe (queue + db)
-   GET /metrics — Metrics snapshot (for internal use)
-   POST /api/jobs — Create a clipping job
-   GET /api/jobs/{id} — Fetch job status and recent events
-   GET /api/jobs/{id}/result — Fetch signed URLs for outputs (when done)

---

## 1) Create a clip job

POST /api/jobs

Request body

```
{
  "sourceType": "upload" | "youtube",
  "uploadKey": "sources/<id>/source.mp4",   // required when sourceType=upload
  "youtubeUrl": "https://www.youtube.com/...", // required when sourceType=youtube
  "start": "HH:MM:SS[.mmm]",                 // inclusive start
  "end": "HH:MM:SS[.mmm]",                   // exclusive end (> start)
  "withSubtitles": false,
  "burnSubtitles": false,
  "subtitleLang": "auto" | "en" | <langCode>
}
```

Example (YouTube)

```
curl -X POST http://localhost:3000/api/jobs \
 -H 'Content-Type: application/json' \
 -d '{
   "sourceType":"youtube",
   "youtubeUrl":"https://www.youtube.com/watch?v=VIDEO",
   "start":"00:01:00",
   "end":"00:01:20",
   "withSubtitles": false
 }'
```

Success (200)

```
{
  "correlationId": "...",
  "job": {
    "id": "uuid",
    "status": "queued",
    "progress": 0,
    "expiresAt": "ISO"
  }
}
```

Errors: 400 Validation error, 429 Rate limited

---

## 2) Check job status

GET /api/jobs/{id}

Success (200)

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
    { "ts": "ISO", "type": "progress", "data": { "pct": 42 } },
    { "ts": "ISO", "type": "done" | "failed" }
  ]
}
```

Errors: 404 Not found, 410 Gone (expired)

---

## 3) Fetch job result

GET /api/jobs/{id}/result

Success (200, only when job is done)

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

Errors: 404 Not ready / Not found, 410 Gone (expired)

---

## Health & Metrics

-   GET /healthz → `{ ok, queue, db, correlationId }`
-   GET /metrics → In‑memory metrics snapshot (shape may evolve)

---

## Typical flow (copy/paste)

1. Create job

```
curl -s -X POST http://localhost:3000/api/jobs \
 -H 'Content-Type: application/json' \
 -d '{
   "sourceType":"upload",
   "uploadKey":"sources/123/source.mp4",
   "start":"00:00:05",
   "end":"00:00:15"
 }'
```

2. Poll status

```
curl -s http://localhost:3000/api/jobs/<jobId>
```

3. Get result when status=done

```
curl -s http://localhost:3000/api/jobs/<jobId>/result
```

---

## Notes & limits

-   Max clip length is enforced (see MAX_CLIP_SECONDS). Start must be before end.
-   If subtitles are requested, `burnSubtitles` requires `withSubtitles=true`.
-   Jobs expire after a retention period; expired jobs return 410 Gone.
