# Authentication & Rate Limiting Tasks

artifact_id: f9b3d1c0-7a4e-4485-9f6e-1b2a3c4d5e6f

## 1. Schema & Migrations

-   [ ] 1.1 Create/augment api_keys table (scopes[], daily_quota, daily_usage, usage_day) (Req 1/3)
-   [ ] 1.2 Index revoked + prefix (Req 1)
-   [ ] 1.3 Add migration for usage_day column (Req 3)

## 2. Key Issuance Script

-   [ ] 2.1 Implement scripts/api-keys.ts issue command (Req 1)
-   [ ] 2.2 Implement list command (Req 1)
-   [ ] 2.3 Implement revoke command (Req 1)
-   [ ] 2.4 Output full token once (Req 1)

## 3. Key Parsing & Verification

-   [ ] 3.1 Implement parseKey(token) (Req 1)
-   [ ] 3.2 Hash secret & verify (Req 1)
-   [ ] 3.3 Unit tests valid/invalid formats (Req 1)

## 4. Cache Layer

-   [ ] 4.1 Implement in-memory TTL cache (Req 9)
-   [ ] 4.2 Add KEY_CACHE_EPOCH invalidation check (Req 9)
-   [ ] 4.3 Metrics hits/misses (Req 9)

## 5. Scopes Enforcement

-   [ ] 5.1 Map endpoints -> scopes (Req 2)
-   [ ] 5.2 Middleware enforce; tests missing scope 403 (Req 2)

## 6. Daily Quota Tracking

-   [ ] 6.1 Update job creation to increment usage (Req 3)
-   [ ] 6.2 Add reset logic based on usage_day (Req 3)
-   [ ] 6.3 Quota exceed 429 path (Req 3)

## 7. Token Buckets

-   [ ] 7.1 Implement per-key bucket (Req 4)
-   [ ] 7.2 Implement per-IP bucket (Req 4)
-   [ ] 7.3 Metrics for rate limit hits (Req 4)
-   [ ] 7.4 Tests for burst + refill (Req 4)

## 8. Global Backpressure

-   [ ] 8.1 Add queue depth + utilization provider (Req 4)
-   [ ] 8.2 Implement overload check returning OVERLOADED/503 (Req 4)
-   [ ] 8.3 Test simulated overload (Req 4)

## 9. Abuse Detection

-   [ ] 9.1 Track validation failures per key/IP (Req 5)
-   [ ] 9.2 Implement cooldown map (Req 5)
-   [ ] 9.3 NOT_FOUND poll threshold logic (Req 5)
-   [ ] 9.4 Tests cooldown activation & expiry (Req 5)

## 10. Audit Logging

-   [ ] 10.1 Emit audit logs for issue/revoke (Req 6)
-   [ ] 10.2 Test log shape (Req 6)

## 11. Introspection Endpoint

-   [ ] 11.1 Implement GET /internal/api-keys/:prefix (Req 7)
-   [ ] 11.2 Auth guard (internal token) (Req 7)
-   [ ] 11.3 Test masking output (Req 7)

## 12. Rate Limit Headers

-   [ ] 12.1 Add X-RateLimit-\* headers in responses (Req 8)
-   [ ] 12.2 Tests header correctness (Req 8)

## 13. Metrics Integration

-   [ ] 13.1 auth.requests_total instrumentation (Req All)
-   [ ] 13.2 auth.rate_limit_hits_total instrumentation (Req 4)
-   [ ] 13.3 auth.quota_exceeded_total instrumentation (Req 3)

## 14. Documentation

-   [ ] 14.1 Update docs/security.md with scopes & quotas (Req 2/3)
-   [ ] 14.2 Add usage examples key issuance (Req 1)

## 15. Rollout

-   [ ] 15.1 Deploy baseline (issue/list/revoke only)
-   [ ] 15.2 Enable scopes enforcement
-   [ ] 15.3 Enable rate limiting improvements
-   [ ] 15.4 Enable quotas & abuse detection

## 16. Future Enhancements (Backlog)

-   [ ] 16.1 Redis bucket backend
-   [ ] 16.2 Tiered plans & analytics
