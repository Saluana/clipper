# API Surface Completion Requirements

artifact_id: 2d7e6d91-4a2c-4f57-9d0f-7a5a0b7a5c21

## Introduction

Close gaps in public API to support efficient client access patterns (reduced polling load, cache friendliness), consistent envelopes, idempotent creation, and signed result delivery semantics. Existing limitations: partial status/result docs, no idempotency key echo, no conditional responses, missing HEAD endpoints, no structured ETag/caching guidance.

## Roles

-   API Client Developer – integrates with job lifecycle
-   Operator – monitors usage & detects abusive patterns
-   SDK Author – relies on stable contracts

## Functional Requirements

1. Idempotent Job Creation

-   Story: As a client I want to safely retry job creation without duplicating work.
-   Acceptance:
    -   WHEN POST /api/jobs includes header `Idempotency-Key` (RFC Idempotency-Key style) THEN server SHALL either create a new job (first seen) or return the previously created job with 200 (or 202) preserving original status.
    -   Response SHALL include header `Idempotency-Key` echo and `Idempotency-Status: replayed|new`.
    -   Stored body hash mismatch for same key within TTL SHALL return 409 CONFLICT with error code `IDEMPOTENCY_MISMATCH`.

2. Job Status Endpoint Enhancements

-   Story: As a client I want conditional caching to reduce bandwidth.
-   Acceptance:
    -   GET /api/jobs/{id} SHALL include `ETag` derived from hash(status, progress, resultKeys, updatedAt) and `Cache-Control: no-cache`.
    -   IF client sends `If-None-Match` matching current ETag THEN server SHALL return 304 with empty body (still include correlationId header).
    -   Endpoint SHALL increment metric jobs.status_fetch.

3. Job Result Endpoint Semantics

-   Story: As a client I want consistent readiness checks & signed URLs.
-   Acceptance:
    -   GET /api/jobs/{id}/result SHALL 404 NOT_READY if status != done; 200 with { result } if done; 410 GONE if expired.
    -   Response SHALL include signed URLs with TTL = SIGNED_URL_TTL_SEC minus safety margin (5%).
    -   Include `Cache-Control: private, max-age=30` and an `ETag` over result keys + expiry.

4. HEAD Result Endpoint

-   Story: As a client optimizing polling I want a lightweight readiness probe.
-   Acceptance:
    -   HEAD /api/jobs/{id}/result SHALL return 204 if ready, 404 if not ready, 410 if gone, mirroring GET semantics without body.

5. Events Streaming (Optional Phase)

-   Story: As a real-time client I want push updates instead of polling.
-   Acceptance:
    -   SSE endpoint GET /api/jobs/{id}/events?stream=true SHALL stream JSON lines of new events until job terminal state or client disconnect.
    -   Heartbeat comment line every 15s to keep connection alive.

6. Standard Error Envelope Enforcement

-   Story: As a client I want uniform error objects for all failures.
-   Acceptance:
    -   ALL non-2xx responses SHALL include `{ error: { code, message, correlationId } }` and no other top-level fields.
    -   Validation errors SHALL include optional `details` array of field issues.

7. Pagination & Filtering (Future-proof)

-   Story: As a dashboard client I may list jobs.
-   Acceptance:
    -   GET /api/jobs?status=processing&limit=50&cursor=<opaque> SHALL return stable ordering (createdAt DESC) and `nextCursor` when more results exist.
    -   Limit bounded to [1,100]. Unknown filters ignored with warning metric.

8. OpenAPI Spec Synchronization

-   Story: As an SDK author I want an accurate machine-readable contract.
-   Acceptance:
    -   Generating /openapi.json SHALL include all new endpoints, headers (Idempotency-Key, ETag, etc), error schemas.

9. Client Caching Guidance Documentation

-   Story: As a developer I want to implement efficient polling.
-   Acceptance:
    -   Docs SHALL describe: use ETag for status, HEAD for result readiness, SSE for push (if enabled), recommended backoff strategy.

10. Correlation ID Propagation

-   Story: As a developer I want consistent trace IDs.
-   Acceptance:
    -   All responses SHALL echo `x-correlation-id` header; server generates if not provided.

11. Rate-Limit Headers (Dependency on Auth Project)

-   Story: As a client I want to know my remaining quota.
-   Acceptance:
    -   Responses MAY include: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` when auth layer supplies context.

## Non-Functional Requirements

-   Backward Compatibility: Existing clients (without Idempotency-Key usage) continue to function unchanged.
-   Performance: Additional hashing for ETag MUST be O(1) relative to job object size (<1ms typical).
-   Security: Signed URLs TTL never exceeds configured; ETag SHALL NOT leak sensitive internal IDs beyond job ID already known.
-   Stability: SSE connections limited via max concurrent streams env guard (MAX_SSE_STREAMS) to avoid resource exhaustion.

## Constraints

-   Idempotency key retention window 24h; storage table pruned by cleanup job.
-   SSE optional; polyfill fallback is polling.

## Out of Scope (Initial Phase)

-   WebSockets upgrade
-   GraphQL API

## Acceptance Validation

-   Integration tests cover: duplicate idempotent create, mismatch body, ETag 304 path, HEAD readiness, result expiry, SSE event sequence, pagination cursors.
