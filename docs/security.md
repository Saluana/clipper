# Security & Abuse Controls

## API Key Authentication

Enabled by setting `ENABLE_API_KEYS=true` in the environment. When enabled, all endpoints except `/healthz`, `/metrics`, and `/metrics/queue` require a valid API key.

Send the key in either header:

-   `Authorization: Bearer <token>`
-   `X-API-Key: <token>`

Tokens are issued via the `api_keys` table logic (`DrizzleApiKeysRepo.issue`). A token format: `ck_<uuid>_<secret>`. Only the hashed secret is stored (Bun.password hashing). On each request the token is unpacked, the secret verified, and the row's `last_used_at` updated. A small in-memory cache (5 min TTL) reduces verification DB hits.

Disable keys by setting `ENABLE_API_KEYS=false` or revoking an individual key (sets `revoked=true`). Revoked keys immediately fail verification.

## Rate Limiting

Applied only to `POST /api/jobs`.

Environment variables:

-   `RATE_LIMIT_WINDOW_SEC` (default 60)
-   `RATE_LIMIT_MAX` (default 30) requests per identity per window

Identity is the API key ID when authenticated, otherwise the caller IP (from `X-Forwarded-For`, then `X-Real-IP`, fallback `ip:anon`). Exceeding the limit returns `429` with code `RATE_LIMITED`.

Implementation: simple fixed window counters stored in-memory (Map). Suitable for single instance; in multi-instance deployments replace with a shared store (Redis) and a leaky bucket or sliding window algorithm.

## SSRF Allowlist & Network Safeguards

YouTube media resolution (`resolveYouTubeSource`) enforces multiple protections:

1. Protocol must be `http` or `https`.
2. Optional hostname allowlist via `ALLOWLIST_HOSTS` (comma separated). If set, any host not in the list is blocked.
3. DNS resolution of the hostname; each resolved IP is checked and blocked if private, loopback, link-local, or otherwise non-public (basic IPv4 & IPv6 checks).
4. DNS resolution failures are treated as blocked.

Violations raise `SSRF_BLOCKED` errors. Unit tests in `src/data/tests/yt-youtube.unit.test.ts` cover these behaviors.

## Future Hardening Ideas

-   Persist rate limit counters in Redis for horizontal scale.
-   Add per-IP + per-key burst token bucket to smooth spikes.
-   Expire/rotate API keys automatically and enforce scopes (read vs write).
-   Add HMAC signature option for payload integrity.

## Operational Notes

-   Ensure `Bun.password` is available (Bun runtime) for API key hashing.
-   Keep `api_keys` table small by revoking unused keys periodically.
-   Monitor `RATE_LIMITED` and `UNAUTHORIZED` counts via metrics (add instrumentation if needed).
