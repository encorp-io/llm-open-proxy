import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { isRetryableUpstreamStatus } from '../src/retry.js';

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
