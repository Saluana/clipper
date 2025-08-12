# Authentication & Rate Limiting Enhancements Requirements

artifact_id: 3a8e61cb-51d6-4934-8e0d-1d264f3b09f5

## Introduction

Strengthen API key authentication, introduce scopes & quotas, and implement layered rate limiting and abuse detection to prevent resource exhaustion prior to horizontal scaling.

## Roles

-   Operator – manages keys, monitors abuse
-   API Client – uses keys to access endpoints
-   Security Engineer – audits access & revocation

## Functional Requirements

1. API Key Lifecycle Management

-   Story: As an operator I want to issue, list, rotate, and revoke keys.
-   Acceptance:
    -   Key issuance script SHALL create token format `ck_<publicId>_<secret>` and store hashed secret plus metadata (createdAt, lastUsedAt, revoked=false, scopes[], dailyQuota, prefix).
    -   Revoking a key SHALL take effect within <=60s (cache TTL bound) and further requests respond 401 UNAUTHORIZED.

2. Key Scopes

-   Story: As an operator I want least-privilege keys.
-   Acceptance:
    -   Keys SHALL have scopes subset of {jobs:create, jobs:read, results:read, uploads:sign, metrics:read}.
    -   Middleware SHALL enforce scope presence for endpoint category and respond 403 FORBIDDEN if missing.

3. Quotas (Daily)

-   Story: As an operator I want to cap per-key daily usage.
-   Acceptance:
    -   Each key MAY have `dailyQuota` (# of job creations). If exceeded THEN POST /api/jobs returns 429 RATE_LIMITED with envelope code `QUOTA_EXCEEDED`.
    -   Counters reset UTC midnight (00:00 UTC) or via sliding window table.

4. Layered Rate Limiting

-   Story: As a platform I want fair usage without central bottleneck.
-   Acceptance:
    -   Per-key token bucket (capacity=B, refill R/sec) enforced before processing job creation.
    -   Per-IP fallback (when unauth) with separate bucket.
    -   Global circuit breaker: IF system load (queue depth > MAX_QUEUE_DEPTH or worker busy ratio > threshold) THEN new job creations respond 503 with code `OVERLOADED` (or 429 with `BACKPRESSURE`).

5. Abuse Detection Signals

-   Story: As an operator I want automatic mitigation for suspicious patterns.
-   Acceptance:
    -   Track validation failure rate per key/IP; IF >X failures in window THEN apply temporary cooldown (return 429 with `COOLDOWN`).
    -   Track repeated NOT_FOUND job status polls for unknown IDs; threshold triggers soft block (shadow mode first).

6. Administrative Audit Logging

-   Story: As a security engineer I need an audit trail for key actions.
-   Acceptance:
    -   Key create/rotate/revoke actions SHALL emit audit log entries with actor, action, keyPrefix, timestamp.

7. Introspection Endpoint (Secure)

-   Story: As an operator I need to introspect a key quickly.
-   Acceptance:
    -   GET /internal/api-keys/{prefix} (auth via internal token) SHALL return masked key metadata (scopes, quota usage, revoked, lastUsedAt).

8. Rate Limit Headers

-   Story: As a client I need to adapt usage.
-   Acceptance:
    -   Successful POST /api/jobs responses SHALL include remaining bucket tokens & reset estimate headers: X-RateLimit-Limit, -Remaining, -Reset.

9. Caching Layer

-   Story: As a performance engineer I want minimal DB hits for key auth.
-   Acceptance:
    -   In-memory LRU or TTL cache SHALL hold key metadata; invalidation on revoke via epoch or version bump environment var (KEY_CACHE_BUSTER optional).

10. Error Codes Extension

-   Story: As a client I need clear auth related error semantics.
-   Acceptance:
    -   Add codes: QUOTA_EXCEEDED, SCOPE_FORBIDDEN, KEY_REVOKED, KEY_INVALID, COOLDOWN, OVERLOADED.

## Non-Functional Requirements

-   Security: Secrets hashed with strong algorithm (bcrypt or Bun.password default) and constant-time compare.
-   Performance: Auth + rate limit middleware adds <2ms p50 overhead.
-   Resilience: Buckets degrade gracefully if cache eviction (fallback to DB check not >10% of requests).
-   Observability: Metrics for auth decisions (allowed, denied, rate_limited, quota_exceeded) & abuse triggers.
-   Scalability: Design pluggable backend (Redis) for distributed buckets.

## Constraints

-   Initial implementation single-instance memory; future cluster uses Redis driver.
-   Daily quota counters persisted to DB for accurate resets.

## Out of Scope

-   OAuth flows, user identity management, UI for key management.

## Acceptance Validation

-   Tests: key issuance + immediate use; revocation; scope enforcement; quota exceed; rate limit bursts; cooldown trigger; circuit breaker activated by synthetic load metrics.
