/**
 * Tool-calling integration tests.
 *
 * We start with Anthropic because it has the most complex translation:
 * the canonical (OpenAI) `tools[]` array becomes Anthropic's
 * `tools[]` with `input_schema` (different field name), and the model's
 * response — which Anthropic emits as `tool_use` content blocks — has
 * to round-trip back into `choices[0].message.tool_calls[]` on the way
 * out. If this test is green, the same pattern works for every other
 * provider (they're mostly OpenAI-shape passthrough).
 */

import { test } from 'node:test';
import { sendAnthropicRequest } from '../../src/index.js';
import assert from 'node:assert/strict';
import {
  WEATHER_TOOL,
  assertToolCall,
  assertUsage,
  skipIfMissingKey,
  call,
} from './helpers.js';

const anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';
const anthropicModel = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5';

test('anthropic — calls the get_weather tool when asked about weather', skipIfMissingKey('ANTHROPIC_API_KEY'), async () => {
  const { response, usage, warnings } = await call(() =>
    sendAnthropicRequest({
      apiKey: anthropicKey,
      body: {
      model: anthropicModel,
      messages: [
        {
          role: 'user',
          content: 'What is the weather in Sofia right now? Use the tool to find out.',
        },
      ],
      tools: [WEATHER_TOOL],
      tool_choice: 'auto',
        // 256 not 32: tool call response contains the full JSON arguments
        // payload plus optional reasoning before the call. Still costs a
        // fraction of a cent.
        max_completion_tokens: 256,
      },
    }),
  );

  // Tool call round-trip: Anthropic's tool_use block → canonical tool_calls.
  assertToolCall(response, 'get_weather', 'Sofia');
  assertUsage(usage);

  // finish_reason should map from Anthropic's `tool_use` stop reason → 'tool_calls'.
  assert.equal(
    response.choices[0]?.finish_reason,
    'tool_calls',
    `expected finish_reason='tool_calls', got '${response.choices[0]?.finish_reason}'`,
  );

  assert.ok(Array.isArray(warnings), 'warnings is not an array');
});
