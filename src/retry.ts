/**
 * Decide whether an upstream HTTP status is worth retrying against a
 * fallback model. Pure helper — callers compose their own retry strategy.
 *
 * Retry on:
 *  - 408 (request timeout)
 *  - 429 (rate limited)
 *  - 500/502/503/504 (provider unavailable / gateway / timeout)
 *  - 529 (Anthropic overloaded)
 *  - 404 (some providers transiently report a model as missing during incidents)
 *
 * Do NOT retry on:
 *  - 400 (bad request — fallback would fail the same way)
 *  - 401/403 (auth — config issue)
 *  - 422 (validation — body is malformed)
 */
export function isRetryableUpstreamStatus(statusCode: number): boolean {
  if (statusCode === 408) return true;
  if (statusCode === 429) return true;
  if (statusCode === 404) return true;
  if (statusCode >= 500) return true;
  return false;
}
