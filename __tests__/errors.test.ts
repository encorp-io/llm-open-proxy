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

  it('toString() renders the upstream body inline for diagnostics', () => {
    const err = new UpstreamError('rate limited', 429, {
      error: { message: 'too many requests', code: 'rate_limit_exceeded' },
    });
    const str = err.toString();
    assert.match(str, /UpstreamError \[429\]: rate limited/);
    assert.match(str, /too many requests/);
    assert.match(str, /rate_limit_exceeded/);
  });

  it('toString() omits the body when it is empty', () => {
    const err = new UpstreamError('boom', 500);
    assert.equal(err.toString(), 'UpstreamError [500]: boom');
  });

  it('toString() handles a string body', () => {
    const err = new UpstreamError('html returned', 502, '<html>...</html>');
    const str = err.toString();
    assert.match(str, /upstreamBody: <html>\.\.\.<\/html>/);
  });

  it('toString() guards against circular refs in the body', () => {
    const circular: Record<string, unknown> = { name: 'self' };
    circular.self = circular;
    const err = new UpstreamError('boom', 500, circular);
    // Should not throw; should render `[Circular]` somewhere.
    const str = err.toString();
    assert.match(str, /\[Circular\]/);
  });

  it('Node util.inspect picks up the custom hook and shows the body', () => {
    // Verify the inspect symbol is wired: Node's util.inspect (which is
    // what `console.log(err)` ends up calling) should return the same
    // rich string as toString(). We import dynamically so the test does
    // not fail in environments without node:util.
    return import('node:util').then(({ inspect }) => {
      const err = new UpstreamError('forbidden', 403, {
        error: { message: 'no access' },
      });
      const inspected = inspect(err);
      assert.match(inspected, /upstreamBody:/);
      assert.match(inspected, /no access/);
    });
  });
});
