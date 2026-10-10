import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  convertChatRequest,
  transformChatRequest,
  isRetryableUpstreamStatus,
  parseRetryAfterMs,
  UpstreamError,
  resolveMaxCompletionTokens,
  stripReasoningContent,
  extractSystemMessages,
  clampTemperature,
  modelMatches,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_THINKING_BUDGET,
  getProviderConfig,
  openaiChatConfig,
  googleChatConfig,
  anthropicChatConfig,
  deepseekChatConfig,
  perplexityChatConfig,
  foundryChatConfig,
  foundryModelInferenceChatConfig,
  sendFoundryRequest,
  streamFoundryRequest,
  convertFoundryRequest,
  buildFoundryUrl,
  getFoundryContentFilterError,
  FOUNDRY_DEPLOYMENTS_API_VERSION,
  FOUNDRY_MODEL_INFERENCE_API_VERSION,
  FOUNDRY_ENTRA_SCOPE,
  AZURE_COGNITIVE_SERVICES_SCOPE,
  sendChatRequest,
  streamChatRequest,
  sendAnthropicRequest,
  streamAnthropicRequest,
  toAnthropicRequest,
  toCanonicalResponse,
  OPENAI_API_URL,
  GOOGLE_OPENAI_COMPAT_URL,
  XAI_API_URL,
  DEEPSEEK_API_URL,
  KIMI_API_URL,
  PERPLEXITY_API_URL,
} from '../src/index.js';
import type { CanonicalChatRequest } from '../src/index.js';

const base: CanonicalChatRequest = {
  model: 'gpt-4o',
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ],
};

describe('convertChatRequest', () => {
  it('routes anthropic to the dedicated translator (system extracted, max_tokens defaulted)', () => {
    const { body, warnings } = convertChatRequest(
      { ...base, model: 'claude-opus-4-6' },
      'anthropic',
    );
    assert.equal((body as { system: string }).system, 'sys');
    assert.equal((body as { max_tokens: number }).max_tokens, 4096);
    assert.ok(warnings.some((w) => /max_tokens/.test(w)));
  });

  it('routes non-anthropic providers through the engine', () => {
    const { body, warnings } = convertChatRequest({ ...base, temperature: 0.5 }, 'openai');
    assert.equal((body as { temperature: number }).temperature, 0.5);
    assert.deepEqual(warnings, []);
  });

  it('uses the OpenAI canonical config for xai and kimi', () => {
    const a = convertChatRequest(base, 'xai');
    const b = convertChatRequest(base, 'kimi');
    assert.equal((a.body as { model: string }).model, 'gpt-4o');
    assert.equal((b.body as { model: string }).model, 'gpt-4o');
  });

  it('routes google through googleChatConfig', () => {
    const { body, warnings } = convertChatRequest(
      { ...base, logit_bias: { x: 1 } },
      'google',
    );
    assert.equal((body as { logit_bias?: unknown }).logit_bias, undefined);
    assert.ok(warnings.some((w) => /logit_bias/.test(w)));
  });

  it('routes deepseek through deepseekChatConfig (user → user_id)', () => {
    const { body } = convertChatRequest({ ...base, user: 'u-1' }, 'deepseek');
    assert.equal((body as { user_id: string }).user_id, 'u-1');
  });

  it('routes foundry through foundryChatConfig (strips reasoning_content, upgrades max_tokens)', () => {
    const { body, warnings } = convertChatRequest(
      {
        ...base,
        max_tokens: 10,
        messages: [...base.messages, { role: 'assistant', content: 'a', reasoning_content: 'r' }],
      },
      'foundry',
    );
    assert.equal((body as { max_completion_tokens: number }).max_completion_tokens, 10);
    const msgs = (body as { messages: Array<{ reasoning_content?: string }> }).messages;
    assert.equal(msgs[2].reasoning_content, undefined);
    assert.deepEqual(warnings, []);
  });

  it('routes perplexity through perplexityChatConfig (drops tool_choice)', () => {
    const { body, warnings } = convertChatRequest(
      { ...base, tool_choice: 'auto' },
      'perplexity',
    );
    assert.equal((body as { tool_choice?: unknown }).tool_choice, undefined);
    assert.ok(warnings.some((w) => /tool_choice/.test(w)));
  });
});

describe('public surface re-exports', () => {
  it('exposes the engine, helpers, errors and retry helper', () => {
    assert.equal(typeof transformChatRequest, 'function');
    assert.equal(typeof resolveMaxCompletionTokens, 'function');
    assert.equal(typeof stripReasoningContent, 'function');
    assert.equal(typeof extractSystemMessages, 'function');
    assert.equal(typeof clampTemperature, 'function');
    assert.equal(typeof modelMatches, 'function');
    assert.equal(typeof isRetryableUpstreamStatus, 'function');
    assert.equal(typeof parseRetryAfterMs, 'function');
    assert.ok(UpstreamError.prototype instanceof Error);
    assert.equal(ANTHROPIC_DEFAULT_MAX_TOKENS, 4096);
    assert.equal(typeof ANTHROPIC_THINKING_BUDGET.medium, 'number');
  });

  it('exposes provider configs and the resolver', () => {
    assert.equal(typeof getProviderConfig, 'function');
    assert.ok(openaiChatConfig);
    assert.ok(googleChatConfig);
    assert.ok(anthropicChatConfig);
    assert.ok(deepseekChatConfig);
    assert.ok(perplexityChatConfig);
    assert.ok(foundryChatConfig);
    assert.ok(foundryModelInferenceChatConfig);
  });

  it('exposes the Microsoft Foundry transport, helpers and constants', () => {
    for (const fn of [
      sendFoundryRequest,
      streamFoundryRequest,
      convertFoundryRequest,
      buildFoundryUrl,
      getFoundryContentFilterError,
    ]) {
      assert.equal(typeof fn, 'function');
    }
    for (const c of [
      FOUNDRY_DEPLOYMENTS_API_VERSION,
      FOUNDRY_MODEL_INFERENCE_API_VERSION,
      FOUNDRY_ENTRA_SCOPE,
      AZURE_COGNITIVE_SERVICES_SCOPE,
    ]) {
      assert.equal(typeof c, 'string');
    }
  });

  it('exposes the transport functions and translator helpers', () => {
    assert.equal(typeof sendChatRequest, 'function');
    assert.equal(typeof streamChatRequest, 'function');
    assert.equal(typeof sendAnthropicRequest, 'function');
    assert.equal(typeof streamAnthropicRequest, 'function');
    assert.equal(typeof toAnthropicRequest, 'function');
    assert.equal(typeof toCanonicalResponse, 'function');
  });

  it('exposes well-known base URL constants', () => {
    for (const u of [
      OPENAI_API_URL,
      GOOGLE_OPENAI_COMPAT_URL,
      XAI_API_URL,
      DEEPSEEK_API_URL,
      KIMI_API_URL,
      PERPLEXITY_API_URL,
    ]) {
      assert.equal(typeof u, 'string');
      assert.match(u, /^https:\/\//);
    }
  });
});
