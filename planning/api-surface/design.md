# API Surface Completion Design

artifact_id: b1d34e2f-2d19-4c42-9b27-6a0d40a9f1a2

## Overview

Add idempotent creation, conditional caching (ETag), signed result delivery semantics, lightweight readiness probes, optional server-sent events for job progress, and pagination. Preserve backward compatibility.

## Architecture

```mermaid
graph TD
  C[Client] -->|POST /api/jobs + Idempotency-Key| A[API]
  C -->|GET/HEAD /api/jobs/:id/result| A
  C -->|GET /api/jobs/:id (ETag)| A
  C -->|SSE /api/jobs/:id/events| A
  A -->|Repos| D[(Postgres)]
  A -->|Sign| S[Storage]
```

## Data Model Additions

-   Table: idempotency_keys

```sql
CREATE TABLE idempotency_keys (
  key text PRIMARY KEY,
  body_hash text NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX ON idempotency_keys (expires_at);
```

Retention via cleanup.

## Idempotent Create Flow

1. Extract `Idempotency-Key` header.
2. Compute `bodyHash = sha256(JSON.stringify(sortedBody))`.
3. Upsert logic:
    - Attempt insert (key, body_hash, job_id=newJobId, expires_at=now()+interval '24h') in one transaction with job row.
    - On conflict (duplicate key): fetch existing row; compare body_hash.
        - If match -> return existing job.
        - Else -> 409 error.

## ETag Strategy

-   Status ETag = weak hash of selected fields: `hash(job.status + job.progress + job.resultVideoKey + job.updatedAt)` -> base64url(sha256(...)).
-   Result ETag = hash(resultVideoKey + resultSrtKey + expiresAt).
-   Implementation: small helper `computeEtag(obj: Partial<JobRecord>)` returns quoted string.

## Conditional GET Handling

```ts
if (ifNoneMatch && ifNoneMatch === etag)
    return Response(null, { status: 304, headers });
```

Always return correlationId header.

## Signed URL Generation

-   Use existing storage repo function sign(key, ttlSeconds).
-   Apply safetyMargin = Math.ceil(ttl \* 0.05) ensuring actual TTL <= SIGNED_URL_TTL_SEC - safetyMargin.
-   Provide refresh guidance to clients: request again if expired (component of docs).

## HEAD /result Endpoint

Reuses same readiness logic but short-circuits body generation.

## SSE Events Endpoint

-   Route: GET /api/jobs/:id/events?stream=1
-   Content-Type: text/event-stream
-   Implementation: fetch existing events -> send as replay (optional) then subscribe to new ones (in-memory pubsub).
-   Heartbeat: send `:keep-alive\n\n` every 15s.
-   Close: on job terminal state send `event: end` then `data: {"status":"done"}\n\n`.
-   Backpressure: ensure write flush aware; simple since low event frequency.
-   Limit concurrency: track active SSE connections; refuse with 503 if > MAX_SSE_STREAMS.

## Pagination

-   Endpoint: GET /api/jobs?status=&limit=&cursor=
-   Cursor: base64url encoded { createdAt: iso, id: uuid } from last row.
-   Query: WHERE (status filter) AND ( (created_at,id) < (cursorCreatedAt,cursorId) ) ORDER BY created_at DESC, id DESC LIMIT n+1.
-   Response: { items:[...], nextCursor? }.

## Error Envelope Enforcement

Add global error handler (already partial) to wrap thrown ServiceError -> envelope.
Ensure validation library (zod) errors mapped to VALIDATION_FAILED with details.

## Middleware Chain

Order:

1. CorrelationId
2. Idempotency (POST jobs only)
3. JSON body parse + validation
4. Handler
5. Error handler wrapper (try/catch)
6. Metrics instrumentation (already separate in observability project)

## Interfaces (TypeScript Sketch)

```ts
interface IdempotencyRepo {
    putFirst(
        key: string,
        bodyHash: string,
        jobId: string,
        ttlSec: number
    ): Promise<'inserted' | 'exists'>;
    get(
        key: string
    ): Promise<{ key: string; bodyHash: string; jobId: string } | null>;
    deleteExpired(now: Date): Promise<number>;
}
```

## Testing Plan

-   Duplicate create same key/body -> same job id.
-   Duplicate create same key/different body -> 409.
-   Status ETag repeat -> 304.
-   Result HEAD readiness transitions.
-   SSE: capture sequence; server terminates after done.
-   Pagination stable ordering with synthetic dataset.

## Security Considerations

-   Idempotency key treated as opaque (not sensitive) but sanitized in logs.
-   SSE prevents header injection via explicit `\n` stripping in event data JSON serialization.
-   Avoid leaking internal DB ids beyond job.id.

## Performance

-   Hashing: Use Bun.crypto.subtle.digest (async) or Node crypto; small object -> negligible (<0.2ms typical).
-   SSE connections: low frequency (<1 msg/sec) -> minimal overhead.

## Rollout

1. Idempotency + ETag core
2. HEAD endpoint
3. Result caching headers
4. Pagination
5. SSE (feature flag ENABLE_SSE_EVENTS)

## Documentation Updates

-   Add Idempotency-Key usage, caching header semantics, SSE example curl.
