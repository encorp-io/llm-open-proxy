import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { transformChatRequest } from '../../src/engine.js';
import { googleChatConfig } from '../../src/providers/google.js';
import type { CanonicalChatRequest } from '../../src/types.js';

const base: CanonicalChatRequest = {
  model: 'gemini-2.5-pro',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('googleChatConfig', () => {
  it('passes through standard sampling fields', () => {
    const { body, warnings } = transformChatRequest(
      { ...base, temperature: 0.7, top_p: 0.9, top_k: 40, n: 2, seed: 42 },
      googleChatConfig,
      'google',
    );
    assert.equal(body.temperature, 0.7);
    assert.equal(body.top_p, 0.9);
    assert.equal(body.top_k, 40);
    assert.equal(body.n, 2);
    assert.equal(body.seed, 42);
    assert.deepEqual(warnings, []);
  });

  it('passes through max_completion_tokens directly', () => {
    const { body } = transformChatRequest(
      { ...base, max_completion_tokens: 200 },
      googleChatConfig,
      'google',
    );
    assert.equal(body.max_completion_tokens, 200);
  });

  it('renames legacy max_tokens into max_completion_tokens via custom transform', () => {
    const { body } = transformChatRequest(
      { ...base, max_tokens: 150 },
      googleChatConfig,
      'google',
    );
    assert.equal(body.max_completion_tokens, 150);
  });

  it('omits max_completion_tokens when neither field is provided', () => {
    const { body } = transformChatRequest(base, googleChatConfig, 'google');
    assert.equal(body.max_completion_tokens, undefined);
  });

  it('drops logit_bias with a warning', () => {
    const { body, warnings } = transformChatRequest(
      { ...base, logit_bias: { '50256': -100 } },
      googleChatConfig,
      'google',
    );
    assert.equal(body.logit_bias, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /logit_bias/);
  });

  it('passes through tools, response_format, reasoning_effort, stream', () => {
    const { body } = transformChatRequest(
      {
        ...base,
        tools: [{ type: 'function', function: { name: 'x' } }],
        response_format: { type: 'json_object' },
        reasoning_effort: 'medium',
        stream: true,
        stream_options: { include_usage: true },
      },
      googleChatConfig,
      'google',
    );
    assert.ok(Array.isArray(body.tools));
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.reasoning_effort, 'medium');
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
  });
});
