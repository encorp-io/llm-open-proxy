import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { isRetryableUpstreamStatus, parseRetryAfterMs } from '../src/retry.js';

describe('isRetryableUpstreamStatus', () => {
  for (const code of [408, 429, 404, 500, 502, 503, 504, 529, 599]) {
    it(`retries on ${code}`, () => {
      assert.equal(isRetryableUpstreamStatus(code), true);
    });
  }

  for (const code of [200, 201, 301, 400, 401, 403, 422, 499]) {
    it(`does not retry on ${code}`, () => {
      assert.equal(isRetryableUpstreamStatus(code), false);
    });
  }
});

describe('parseRetryAfterMs', () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it('prefers retry-after-ms', () => {
    assert.equal(parseRetryAfterMs(h({ 'retry-after-ms': '1500', 'retry-after': '9' })), 1500);
  });

  it('falls back to retry-after seconds when retry-after-ms is unusable', () => {
    assert.equal(parseRetryAfterMs(h({ 'retry-after': '2' })), 2000);
    assert.equal(parseRetryAfterMs(h({ 'retry-after-ms': 'soon', 'retry-after': '3' })), 3000);
    assert.equal(parseRetryAfterMs(h({ 'retry-after-ms': '-5', 'retry-after': '0' })), 0);
  });

  it('parses an HTTP-date retry-after, clamping past dates to 0', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const ms = parseRetryAfterMs(h({ 'retry-after': future }));
    assert.ok(ms !== undefined && ms > 50_000 && ms <= 60_000, `got ${ms}`);
    assert.equal(parseRetryAfterMs(h({ 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' })), 0);
  });

  it('returns undefined when no usable header is present', () => {
    assert.equal(parseRetryAfterMs(h({})), undefined);
    assert.equal(parseRetryAfterMs(h({ 'retry-after': 'later' })), undefined);
    assert.equal(parseRetryAfterMs(h({ 'retry-after-ms': ' ' })), undefined);
  });
});
