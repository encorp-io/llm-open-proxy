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

/**
 * Read an upstream back-off hint from response headers, in milliseconds.
 *
 * Prefers `retry-after-ms` (sent by Azure OpenAI / Microsoft Foundry and
 * OpenAI), then falls back to the standard `retry-after`, which is either
 * delta-seconds or an HTTP-date. Returns `undefined` when neither header is
 * present or parseable.
 */
export function parseRetryAfterMs(headers: Headers): number | undefined {
  const ms = parseNonNegative(headers.get('retry-after-ms'));
  if (ms !== undefined) return ms;

  const retryAfter = headers.get('retry-after');
  const seconds = parseNonNegative(retryAfter);
  if (seconds !== undefined) return seconds * 1000;
  if (retryAfter) {
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return undefined;
}

function parseNonNegative(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
