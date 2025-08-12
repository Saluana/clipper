# API Surface Completion Tasks

artifact_id: e3f74a8e-3d52-4a28-9461-b4c2fbf0d0c5

## 1. Idempotency Infrastructure

-   [ ] 1.1 Create migration for idempotency_keys table (Req 1)
-   [ ] 1.2 Implement IdempotencyRepo.putFirst/get (Req 1)
-   [ ] 1.3 Add POST /api/jobs middleware reading Idempotency-Key (Req 1)
-   [ ] 1.4 Body hash computation + mismatch 409 path (Req 1)
-   [ ] 1.5 Integration tests duplicate key same body (Req 1)
-   [ ] 1.6 Integration tests mismatch body (Req 1)

## 2. Status Endpoint ETag

-   [ ] 2.1 Implement computeStatusEtag helper (Req 2)
-   [ ] 2.2 Inject ETag + Cache-Control headers (Req 2)
-   [ ] 2.3 304 response logic (Req 2)
-   [ ] 2.4 Test conditional GET success (Req 2)

## 3. Result Endpoint Semantics

-   [ ] 3.1 Add readiness checks & NOT_READY 404 (Req 3)
-   [ ] 3.2 Implement signed URL generation with safety margin (Req 3)
-   [ ] 3.3 Add result ETag + Cache-Control (Req 3)
-   [ ] 3.4 Test expired job 410 path (Req 3)

## 4. HEAD /result Endpoint

-   [ ] 4.1 Implement HEAD handler logic reuse (Req 4)
-   [ ] 4.2 Test HEAD readiness states (Req 4)

## 5. SSE Events (Feature Flag)

-   [ ] 5.1 Add ENABLE_SSE_EVENTS env (Req 5)
-   [ ] 5.2 Implement SSE handler with heartbeat (Req 5)
-   [ ] 5.3 Connection limit enforcement (Req 5)
-   [ ] 5.4 Test sequence & termination (Req 5)

## 6. Error Envelope Enforcement

-   [ ] 6.1 Review all handlers for uniform error return (Req 6)
-   [ ] 6.2 Central error middleware wrap (Req 6)
-   [ ] 6.3 Validation details shape (Req 6)
-   [ ] 6.4 Tests for envelope consistency (Req 6)

## 7. Pagination

-   [ ] 7.1 Migration (if needed) indexes for created_at,id (Req 7)
-   [ ] 7.2 Implement list handler with cursor encoding (Req 7)
-   [ ] 7.3 Tests multi-page listing (Req 7)

## 8. OpenAPI Spec Update

-   [ ] 8.1 Extend schemas: headers Idempotency-Key, ETag (Req 8)
-   [ ] 8.2 Generate and validate openapi.json includes new endpoints (Req 8)

## 9. Docs Update

-   [ ] 9.1 Update docs/api-reference.md with idempotency section (Req 9)
-   [ ] 9.2 Add caching & polling guidance (Req 9)
-   [ ] 9.3 Add SSE usage example (Req 9/5)

## 10. Correlation ID Echo

-   [ ] 10.1 Ensure header x-correlation-id returned everywhere (Req 10)
-   [ ] 10.2 Test missing inbound ID generation (Req 10)

## 11. Rate Limit Headers (Dependency)

-   [ ] 11.1 Integrate with auth layer to set X-RateLimit-\* (Req 11)
-   [ ] 11.2 Tests headers present when key provided (Req 11)

## 12. Rollout Phases

-   [ ] 12.1 Phase 1 deploy (idempotency + ETags)
-   [ ] 12.2 Phase 2 deploy (HEAD + result semantics)
-   [ ] 12.3 Phase 3 deploy (pagination + docs)
-   [ ] 12.4 Phase 4 deploy (SSE)
