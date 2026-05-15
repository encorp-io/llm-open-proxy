import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { UpstreamError } from '../src/errors.js';

describe('UpstreamError', () => {
  it('captures message, statusCode and upstream body', () => {
    const body = { error: { message: 'rate limited' } };
    const err = new UpstreamError('rate limited', 429, body);
    assert.equal(err.message, 'rate limited');
    assert.equal(err.statusCode, 429);
    assert.equal(err.upstreamBody, body);
    assert.equal(err.name, 'UpstreamError');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof UpstreamError);
  });

  it('defaults upstreamBody to an empty object when omitted', () => {
    const err = new UpstreamError('boom', 500);
    assert.deepEqual(err.upstreamBody, {});
  });
});
