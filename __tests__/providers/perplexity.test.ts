import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { transformChatRequest } from '../../src/engine.js';
import { perplexityChatConfig } from '../../src/providers/perplexity.js';
import type { CanonicalChatRequest } from '../../src/types.js';

const base: CanonicalChatRequest = {
  model: 'sonar-large',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('perplexityChatConfig', () => {
  it('passes through temperature/top_p/stop/user/response_format/tools/reasoning_effort/stream', () => {
    const { body, warnings } = transformChatRequest(
      {
        ...base,
        temperature: 0.5,
        top_p: 0.9,
        stop: ['END'],
        user: 'u',
        response_format: { type: 'json_object' },
        tools: [{ type: 'function', function: { name: 'x' } }],
        reasoning_effort: 'medium',
        stream: true,
        stream_options: { include_usage: true },
      },
      perplexityChatConfig,
      'perplexity',
    );
    assert.equal(body.temperature, 0.5);
    assert.equal(body.top_p, 0.9);
    assert.deepEqual(body.stop, ['END']);
    assert.equal(body.user, 'u');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.ok(Array.isArray(body.tools));
    assert.equal(body.reasoning_effort, 'medium');
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.deepEqual(warnings, []);
  });

  it('drops every unsupported field with a reason', () => {
    const { body, warnings } = transformChatRequest(
      {
        ...base,
        top_k: 40,
        n: 2,
        frequency_penalty: 0.1,
        presence_penalty: 0.1,
        logit_bias: { x: 1 },
        seed: 5,
        logprobs: true,
        top_logprobs: 5,
        tool_choice: 'auto',
        parallel_tool_calls: true,
      },
      perplexityChatConfig,
      'perplexity',
    );
    for (const f of [
      'top_k',
      'n',
      'frequency_penalty',
      'presence_penalty',
      'logit_bias',
      'seed',
      'logprobs',
      'top_logprobs',
      'tool_choice',
      'parallel_tool_calls',
    ]) {
      assert.equal(body[f], undefined);
      assert.ok(
        warnings.some((w) => w.includes(`'${f}' dropped for perplexity`)),
        `expected warning for ${f}, got: ${warnings.join('; ')}`,
      );
    }
  });

  it('renames max_completion_tokens → max_tokens', () => {
    const { body } = transformChatRequest(
      { ...base, max_completion_tokens: 200 },
      perplexityChatConfig,
      'perplexity',
    );
    assert.equal(body.max_tokens, 200);
  });

  it('renames legacy max_tokens via the custom transform', () => {
    const { body } = transformChatRequest(
      { ...base, max_tokens: 150 },
      perplexityChatConfig,
      'perplexity',
    );
    assert.equal(body.max_tokens, 150);
  });

  it('omits max_tokens when neither field provided', () => {
    const { body } = transformChatRequest(base, perplexityChatConfig, 'perplexity');
    assert.equal(body.max_tokens, undefined);
  });
});
