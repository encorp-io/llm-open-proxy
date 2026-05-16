/**
 * Tool-calling integration tests, one per provider.
 *
 * Anthropic is the headline case because the translation is bidirectional:
 * canonical `tools[]` → Anthropic `tools[]` with `input_schema` on the way
 * out, and Anthropic's `tool_use` content block → canonical `tool_calls[]`
 * on the way back. Other providers speak OpenAI's tools shape natively so
 * they're pure passthrough — these tests catch regressions in the
 * generic engine, not in custom translation.
 *
 * Perplexity is special-cased: their Sonar models do not support function
 * calling at all. The library does not currently warn or reject the
 * `tools` field on Perplexity, so the test asserts that the upstream
 * returns an error rather than silently dropping the tool. If/when the
 * library learns to strip tools for Perplexity at conversion time, the
 * assertion in that test should flip to checking the warnings array.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sendAnthropicRequest,
  sendChatRequest,
  convertChatRequest,
  UpstreamError,
  DEEPSEEK_API_URL,
  GOOGLE_OPENAI_COMPAT_URL,
  KIMI_API_URL,
  PERPLEXITY_API_URL,
  XAI_API_URL,
  type CanonicalChatRequest,
} from '../../src/index.js';
import {
  WEATHER_TOOL,
  assertToolCall,
  assertUsage,
  skipIfMissingKey,
  call,
} from './helpers.js';

const WEATHER_PROMPT: CanonicalChatRequest['messages'] = [
  { role: 'user', content: 'What is the weather in Sofia right now? Use the tool to find out.' },
];

// ---------------------------------------------------------------------------
// Anthropic — the hardest translation
// ---------------------------------------------------------------------------

test('anthropic — calls the get_weather tool when asked about weather', skipIfMissingKey('ANTHROPIC_API_KEY'), async () => {
  const { response, usage, warnings } = await call(() =>
    sendAnthropicRequest({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      body: {
        model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
        messages: WEATHER_PROMPT,
        tools: [WEATHER_TOOL],
        tool_choice: 'auto',
        max_completion_tokens: 256,
      },
    }),
  );

  assertToolCall(response, 'get_weather', 'Sofia');
  assertUsage(usage);
  assert.equal(
    response.choices[0]?.finish_reason,
    'tool_calls',
    `expected finish_reason='tool_calls', got '${response.choices[0]?.finish_reason}'`,
  );
  assert.ok(Array.isArray(warnings), 'warnings is not an array');
});

// ---------------------------------------------------------------------------
// OpenAI-shape providers — generic engine passthrough
// ---------------------------------------------------------------------------

interface OpenAIShapeToolCase {
  envKey: string;
  providerLabel: string;
  provider: 'openai' | 'google' | 'deepseek' | 'xai' | 'kimi';
  modelEnv: string;
  defaultModel: string;
  baseUrl: string | undefined;
}

const openAIShapeToolCases: OpenAIShapeToolCase[] = [
  {
    envKey: 'OPENAI_API_KEY',
    providerLabel: 'openai',
    provider: 'openai',
    modelEnv: 'OPENAI_MODEL',
    defaultModel: 'gpt-4o-mini',
    baseUrl: undefined,
  },
  {
    envKey: 'GOOGLE_API_KEY',
    providerLabel: 'google',
    provider: 'google',
    modelEnv: 'GOOGLE_MODEL',
    defaultModel: 'gemini-2.5-flash',
    baseUrl: GOOGLE_OPENAI_COMPAT_URL,
  },
  {
    envKey: 'DEEPSEEK_API_KEY',
    providerLabel: 'deepseek',
    provider: 'deepseek',
    modelEnv: 'DEEPSEEK_MODEL',
    defaultModel: 'deepseek-chat',
    baseUrl: DEEPSEEK_API_URL,
  },
  {
    envKey: 'XAI_API_KEY',
    providerLabel: 'xai (Grok)',
    provider: 'xai',
    modelEnv: 'XAI_MODEL',
    defaultModel: 'grok-3-mini',
    baseUrl: XAI_API_URL,
  },
  {
    envKey: 'KIMI_API_KEY',
    providerLabel: 'kimi (Moonshot)',
    provider: 'kimi',
    modelEnv: 'KIMI_MODEL',
    defaultModel: 'kimi-k2-0905-preview',
    baseUrl: KIMI_API_URL,
  },
];

for (const c of openAIShapeToolCases) {
  test(`${c.providerLabel} — calls the get_weather tool`, skipIfMissingKey(c.envKey), async () => {
    const { body } = convertChatRequest(
      {
        model: process.env[c.modelEnv] ?? c.defaultModel,
        messages: WEATHER_PROMPT,
        tools: [WEATHER_TOOL],
        tool_choice: 'auto',
        max_completion_tokens: 256,
      },
      c.provider,
    );
    const { response, usage } = await call(() =>
      sendChatRequest({
        apiKey: process.env[c.envKey]!,
        body,
        baseUrl: c.baseUrl,
      }),
    );

    assertToolCall(response, 'get_weather', 'Sofia');
    assertUsage(usage);
    assert.equal(
      response.choices[0]?.finish_reason,
      'tool_calls',
      `expected finish_reason='tool_calls' for ${c.providerLabel}, got '${response.choices[0]?.finish_reason}'`,
    );
  });
}

// ---------------------------------------------------------------------------
// Perplexity — does NOT support function calling
// ---------------------------------------------------------------------------

test('perplexity — rejects tool definitions (sonar has no function calling)', skipIfMissingKey('PERPLEXITY_API_KEY'), async () => {
  const { body } = convertChatRequest(
    {
      model: process.env.PERPLEXITY_MODEL ?? 'sonar',
      messages: WEATHER_PROMPT,
      tools: [WEATHER_TOOL],
      tool_choice: 'auto',
      max_completion_tokens: 64,
    },
    'perplexity',
  );

  // Perplexity should respond with a 4xx error rather than silently
  // ignoring the tool. If/when the library learns to strip tools for
  // Perplexity at conversion time and emit a warning instead, this
  // assertion should be flipped to check `warnings` and expect a
  // successful response with content but no tool_calls.
  let thrown: unknown;
  try {
    await sendChatRequest({
      apiKey: process.env.PERPLEXITY_API_KEY!,
      body,
      baseUrl: PERPLEXITY_API_URL,
    });
  } catch (e) {
    thrown = e;
  }

  assert.ok(
    thrown instanceof UpstreamError,
    `expected UpstreamError, got: ${thrown === undefined ? 'no error thrown' : String(thrown)}`,
  );
  assert.ok(
    (thrown as UpstreamError).statusCode >= 400 && (thrown as UpstreamError).statusCode < 500,
    `expected 4xx, got ${(thrown as UpstreamError).statusCode}`,
  );
});
