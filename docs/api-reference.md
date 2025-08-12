# API Reference

Base URL: `https://{host}`
All responses include a `correlationId` when successful or inside the `error` envelope.
If API key auth is enabled (ENABLE_API_KEYS=true) you must send one of:

-   `Authorization: Bearer <token>`
-   `X-API-Key: <token>`

Error envelope (non-2xx):

```json
{ "error": { "code": "STRING", "message": "STRING", "correlationId": "UUID" } }
```

Common error codes: VALIDATION_FAILED, NOT_FOUND, GONE, NOT_READY, UNAUTHORIZED, RATE_LIMITED, INTERNAL.

---

## Create Clip Job

POST `/api/jobs`

Request body:

```json
{
    "sourceType": "upload", // or "youtube"
    "uploadKey": "sources/{jobId}/source.mp4", // required when sourceType=upload
    "youtubeUrl": "https://www.youtube.com/watch?v=...", // required when sourceType=youtube
    "start": "HH:MM:SS(.ms)",
    "end": "HH:MM:SS(.ms)",
    "withSubtitles": true,
    "burnSubtitles": false,
    "subtitleLang": "auto" // optional
}
```

Notes:

-   Duration must not exceed `MAX_CLIP_SECONDS` (default 120).
-   Expiration is set to now + `RETENTION_HOURS` (default 72) in job.expiresAt.

Successful response (201 style 200):

```json
{
    "correlationId": "...",
    "job": {
        "id": "...",
        "status": "queued",
        "progress": 0,
        "expiresAt": "2025-..."
    }
}
```

Curl example (upload source):

```bash
curl -X POST "$BASE/api/jobs" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{
    "sourceType":"upload",
    "uploadKey":"sources/123/source.mp4",
    "start":"00:00:00",
    "end":"00:00:05",
    "withSubtitles":true,
    "burnSubtitles":false,
    "subtitleLang":"auto"
  }'
```

Curl example (YouTube source):

```bash
curl -X POST "$BASE/api/jobs" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{
    "sourceType":"youtube",
    "youtubeUrl":"https://www.youtube.com/watch?v=abcdef",
    "start":"00:00:05",
    "end":"00:00:20",
    "withSubtitles":false,
    "burnSubtitles":false
  }'
```

Rate limiting:

-   If configured, exceeding limit returns 429 with code RATE_LIMITED.

---

## Get Job Status

GET `/api/jobs/{id}`

Example:

```bash
curl -H "Authorization: Bearer $API_TOKEN" "$BASE/api/jobs/$JOB_ID"
```

Success response:

```json
{
    "correlationId": "...",
    "job": {
        "id": "...",
        "status": "queued|processing|done|failed",
        "progress": 0,
        "resultVideoKey": "results/.../clip.mp4",
        "resultSrtKey": "results/.../clip.srt",
        "expiresAt": "2025-..."
    },
    "events": [{ "ts": "2025-...", "type": "created", "data": {} }]
}
```

Special cases:

-   404 NOT_FOUND if job missing.
-   410 GONE if expired.

---

## Get Job Result (Signed URLs)

GET `/api/jobs/{id}/result`

Returns signed URLs when job is done.

```bash
curl -H "Authorization: Bearer $API_TOKEN" "$BASE/api/jobs/$JOB_ID/result"
```

Success (status=done):

```json
{
    "correlationId": "...",
    "result": {
        "id": "...",
        "video": {
            "key": "results/.../clip.mp4",
            "url": "https://...signed..."
        },
        "srt": { "key": "results/.../clip.srt", "url": "https://...signed..." }
    }
}
```

Errors:

-   404 NOT_FOUND if job missing or not ready (code NOT_READY when still processing).
-   410 GONE if expired.
-   500 STORAGE_UNAVAILABLE if signing disabled.

---

## Health & Metrics

GET `/healthz` basic readiness.
GET `/metrics` returns JSON snapshot of internal counters/histograms.
GET `/metrics/queue` exposes queue depth/health snapshot.

---

## Error Examples

Validation failure:

```json
{
    "error": {
        "code": "VALIDATION_FAILED",
        "message": "...",
        "correlationId": "..."
    }
}
```

Rate limited:

```json
{
    "error": {
        "code": "RATE_LIMITED",
        "message": "Rate limit exceeded",
        "correlationId": "..."
    }
}
```

---

## Versioning

Current API unversioned; breaking changes will introduce `/v1/` prefix.
