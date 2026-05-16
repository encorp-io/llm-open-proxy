/**
 * Streaming + tool calling — the most error-prone combination.
 *
 * When a model emits a tool call inside a stream, the tool_call's
 * `function.arguments` arrives as a sequence of string deltas across SSE
 * chunks. Each delta is a JSON *fragment*, not a complete value:
 *
 *   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"get_weather"}}]}}]}
 *   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\""}}]}}]}
 *   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"city"}}]}}]}
 *   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\":\""}}]}}]}
 *   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"Sofia"}}]}}]}
 *   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"}"}}]}}]}
 *   data: [DONE]
 *
 * The library has to accumulate these correctly. For Anthropic, where
 * the upstream streams `tool_use` blocks in a completely different
 * native event format (`content_block_start`, `input_json_delta`,
 * `content_block_stop`), the library has to translate event-by-event
 * into OpenAI-shape deltas. That's where bugs love to hide.
 *
 * These tests:
 *   - drain the stream via `collectSseToolCalls` (accumulator helper)
 *   - assert exactly one assembled tool call with the right name
 *   - assert the accumulated `arguments` string is valid JSON and
 *     mentions the expected city.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  streamAnthropicRequest,
  streamChatRequest,
  convertChatRequest,
} from '../../src/index.js';
import {
  WEATHER_TOOL,
  collectSseToolCalls,
  skipIfMissingKey,
  call,
} from './helpers.js';

const WEATHER_USER_MSG = {
  role: 'user' as const,
  content: 'What is the weather in Sofia right now? Use the tool to find out.',
};

test('anthropic — streaming tool call assembles correctly from input_json_delta events', skipIfMissingKey('ANTHROPIC_API_KEY'), async () => {
  const { stream } = await call(() =>
    streamAnthropicRequest({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      body: {
        model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
        messages: [WEATHER_USER_MSG],
        tools: [WEATHER_TOOL],
        tool_choice: 'auto',
        max_completion_tokens: 256,
        stream: true,
      },
    }),
  );

  const toolCalls = await collectSseToolCalls(stream);
  assert.equal(
    toolCalls.length,
    1,
    `expected exactly 1 assembled tool call, got ${toolCalls.length}: ${JSON.stringify(toolCalls, null, 2)}`,
  );

  const tc = toolCalls[0]!;
  assert.equal(tc.name, 'get_weather', `expected name=get_weather, got: ${tc.name}`);
  assert.ok(tc.arguments.length > 0, 'arguments string is empty after accumulating deltas');

  // The accumulated argument fragments must concatenate into valid JSON.
  // If a chunk boundary fell inside a string and we lost a byte, JSON.parse
  // throws — that's the canary we want.
  let parsed: { city?: string };
  try {
    parsed = JSON.parse(tc.arguments) as { city?: string };
  } catch (e) {
    assert.fail(`accumulated arguments are not valid JSON: ${tc.arguments}\nparse error: ${(e as Error).message}`);
  }
  assert.ok(
    typeof parsed.city === 'string' && parsed.city.toLowerCase().includes('sofia'),
    `expected args.city to include "Sofia", got: ${JSON.stringify(parsed)}`,
  );
});

test('openai — streaming tool call assembles correctly across SSE chunks', skipIfMissingKey('OPENAI_API_KEY'), async () => {
  const { body } = convertChatRequest(
    {
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      messages: [WEATHER_USER_MSG],
      tools: [WEATHER_TOOL],
      tool_choice: 'auto',
      max_completion_tokens: 256,
      stream: true,
    },
    'openai',
  );

  const { stream } = await call(() =>
    streamChatRequest({
      apiKey: process.env.OPENAI_API_KEY!,
      body,
    }),
  );

  const toolCalls = await collectSseToolCalls(stream);
  assert.equal(
    toolCalls.length,
    1,
    `expected exactly 1 assembled tool call, got ${toolCalls.length}: ${JSON.stringify(toolCalls, null, 2)}`,
  );

  const tc = toolCalls[0]!;
  assert.equal(tc.name, 'get_weather');

  let parsed: { city?: string };
  try {
    parsed = JSON.parse(tc.arguments) as { city?: string };
  } catch (e) {
    assert.fail(`accumulated arguments are not valid JSON: ${tc.arguments}\nparse error: ${(e as Error).message}`);
  }
  assert.ok(
    typeof parsed.city === 'string' && parsed.city.toLowerCase().includes('sofia'),
    `expected args.city to include "Sofia", got: ${JSON.stringify(parsed)}`,
  );
});
