import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { transformChatRequest } from '../../src/engine.js';
import { deepseekChatConfig } from '../../src/providers/deepseek.js';
import type { CanonicalChatRequest } from '../../src/types.js';

const base: CanonicalChatRequest = {
  model: 'deepseek-v4',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('deepseekChatConfig', () => {
  it('passes through temperature/top_p/stop/tools', () => {
    const { body, warnings } = transformChatRequest(
      {
        ...base,
        temperature: 0.4,
        top_p: 0.9,
        stop: ['END'],
        tools: [{ type: 'function', function: { name: 'x' } }],
      },
      deepseekChatConfig,
      'deepseek',
    );
    assert.equal(body.temperature, 0.4);
    assert.equal(body.top_p, 0.9);
    assert.deepEqual(body.stop, ['END']);
    assert.ok(Array.isArray(body.tools));
    assert.deepEqual(warnings, []);
  });

  it('drops top_k, n, frequency_penalty, presence_penalty, logit_bias, seed, parallel_tool_calls', () => {
    const { body, warnings } = transformChatRequest(
      {
        ...base,
        top_k: 40,
        n: 2,
        frequency_penalty: 0.1,
        presence_penalty: 0.1,
        logit_bias: { x: 1 },
        seed: 5,
        parallel_tool_calls: false,
      },
      deepseekChatConfig,
      'deepseek',
    );
    for (const f of [
      'top_k',
      'n',
      'frequency_penalty',
      'presence_penalty',
      'logit_bias',
      'seed',
      'parallel_tool_calls',
    ]) {
      assert.equal(body[f], undefined);
      assert.ok(
        warnings.some((w) => w.includes(`'${f}' dropped for deepseek`)),
        `expected warning for ${f}, got: ${warnings.join('; ')}`,
      );
    }
  });

  it('renames max_completion_tokens → max_tokens', () => {
    const { body } = transformChatRequest(
      { ...base, max_completion_tokens: 200 },
      deepseekChatConfig,
      'deepseek',
    );
    assert.equal(body.max_tokens, 200);
  });

  it('renames legacy max_tokens via the custom transform', () => {
    const { body } = transformChatRequest(
      { ...base, max_tokens: 150 },
      deepseekChatConfig,
      'deepseek',
    );
    assert.equal(body.max_tokens, 150);
  });

  it('omits max_tokens when neither field provided', () => {
    const { body } = transformChatRequest(base, deepseekChatConfig, 'deepseek');
    assert.equal(body.max_tokens, undefined);
  });

  it('renames user → user_id', () => {
    const { body } = transformChatRequest(
      { ...base, user: 'u-1' },
      deepseekChatConfig,
      'deepseek',
    );
    assert.equal(body.user_id, 'u-1');
    assert.equal(body.user, undefined);
  });

  it('maps reasoning_effort: high → high', () => {
    const { body } = transformChatRequest(
      { ...base, reasoning_effort: 'high' },
      deepseekChatConfig,
      'deepseek',
    );
    assert.deepEqual(body.thinking, { type: 'enabled', reasoning_effort: 'high' });
  });

  it('maps reasoning_effort: medium → high', () => {
    const { body } = transformChatRequest(
      { ...base, reasoning_effort: 'medium' },
      deepseekChatConfig,
      'deepseek',
    );
    assert.deepEqual(body.thinking, { type: 'enabled', reasoning_effort: 'high' });
  });

  it('maps reasoning_effort: low → max', () => {
    const { body } = transformChatRequest(
      { ...base, reasoning_effort: 'low' },
      deepseekChatConfig,
      'deepseek',
    );
    assert.deepEqual(body.thinking, { type: 'enabled', reasoning_effort: 'max' });
  });

  it('maps reasoning_effort: minimal → max', () => {
    const { body } = transformChatRequest(
      { ...base, reasoning_effort: 'minimal' },
      deepseekChatConfig,
      'deepseek',
    );
    assert.deepEqual(body.thinking, { type: 'enabled', reasoning_effort: 'max' });
  });

  it('passes through logprobs/top_logprobs/response_format/tool_choice/stream', () => {
    const { body } = transformChatRequest(
      {
        ...base,
        logprobs: true,
        top_logprobs: 5,
        response_format: { type: 'json_object' },
        tool_choice: 'auto',
        stream: true,
        stream_options: { include_usage: true },
      },
      deepseekChatConfig,
      'deepseek',
    );
    assert.equal(body.logprobs, true);
    assert.equal(body.top_logprobs, 5);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.tool_choice, 'auto');
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
  });
});
