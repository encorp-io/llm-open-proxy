/**
 * Multi-turn tool-call round-trip tests.
 *
 * Verifies the complete "agent loop" flow that real applications use:
 *
 *   1. User asks: "What's the weather in Sofia?"
 *   2. Model responds with a tool_call to get_weather({city: "Sofia"}).
 *   3. We synthesize a tool response ("sunny, 22°C") and send it back as
 *      a `role: tool` message with the matching `tool_call_id`.
 *   4. Model uses the tool result to produce a final natural-language
 *      answer that mentions the weather we provided.
 *
 * This is where the trickiest translation lives:
 *
 *   - Anthropic: the canonical `{ role: 'tool', tool_call_id, content }`
 *     message has to become a `{ role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }`
 *     block. And the prior assistant turn (with `tool_calls`) has to
 *     become an assistant content array containing a `tool_use` block
 *     with the same id. If id matching breaks, the model loses context.
 *
 *   - OpenAI-shape: passthrough, but we still test it as a regression
 *     guard for the canonical → canonical engine path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sendAnthropicRequest,
  sendChatRequest,
  convertChatRequest,
} from '../../src/index.js';
import {
  WEATHER_TOOL,
  assertUsage,
  skipIfMissingKey,
  call,
} from './helpers.js';

const FAKE_WEATHER_RESULT = 'It is currently sunny and 22 degrees Celsius in Sofia.';

test('anthropic — full tool round-trip: request → tool_use → tool_result → final answer', skipIfMissingKey('ANTHROPIC_API_KEY'), async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const model = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5';

  // Turn 1: ask about weather. Model should emit a tool_use.
  const turn1 = await call(() =>
    sendAnthropicRequest({
      apiKey,
      body: {
        model,
        messages: [
          { role: 'user', content: 'What is the weather in Sofia? Use the tool.' },
        ],
        tools: [WEATHER_TOOL],
        tool_choice: 'auto',
        max_completion_tokens: 256,
      },
    }),
  );

  const toolCall = turn1.response.choices[0]?.message.tool_calls?.[0];
  assert.ok(toolCall, `expected tool_call on turn 1, got: ${JSON.stringify(turn1.response.choices[0]?.message)}`);
  assert.equal(toolCall.function.name, 'get_weather');

  // Turn 2: feed the tool result back. The library must reshape the
  // assistant turn (with tool_calls) into Anthropic's tool_use content
  // block, then translate `role: tool` into a user message with a
  // tool_result block — with the SAME id linking them.
  const turn2 = await call(() =>
    sendAnthropicRequest({
      apiKey,
      body: {
        model,
        messages: [
          { role: 'user', content: 'What is the weather in Sofia? Use the tool.' },
          {
            role: 'assistant',
            content: turn1.response.choices[0]?.message.content ?? null,
            tool_calls: [toolCall],
          },
          {
            role: 'tool',
            tool_call_id: toolCall.id,
            content: FAKE_WEATHER_RESULT,
          },
        ],
        tools: [WEATHER_TOOL],
        max_completion_tokens: 256,
      },
    }),
  );

  // The model should now produce a natural-language answer rather than
  // another tool_use. If id matching broke during translation, the model
  // wouldn't have seen the tool result and would either call the tool
  // again or hallucinate.
  const finalContent = turn2.response.choices[0]?.message.content;
  assert.ok(
    typeof finalContent === 'string' && finalContent.length > 0,
    `expected text content on turn 2, got: ${JSON.stringify(turn2.response.choices[0]?.message)}`,
  );
  // Loose check that the model actually incorporated the tool result.
  // We assert on "22" rather than the full sentence because models
  // paraphrase. If neither "22" nor "sunny" appears, something dropped
  // the tool_result block on the way to the model.
  const lower = finalContent.toLowerCase();
  assert.ok(
    lower.includes('22') || lower.includes('sunny') || lower.includes('warm') || lower.includes('clear'),
    `final answer does not mention the tool result we provided. Got: "${finalContent}"`,
  );
  assertUsage(turn2.usage);
});

test('openai — full tool round-trip: request → tool_call → tool result → final answer', skipIfMissingKey('OPENAI_API_KEY'), async () => {
  const apiKey = process.env.OPENAI_API_KEY!;
  const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

  const { body: body1 } = convertChatRequest(
    {
      model,
      messages: [
        { role: 'user', content: 'What is the weather in Sofia? Use the tool.' },
      ],
      tools: [WEATHER_TOOL],
      tool_choice: 'auto',
      max_completion_tokens: 256,
    },
    'openai',
  );
  const turn1 = await call(() => sendChatRequest({ apiKey, body: body1 }));

  const toolCall = turn1.response.choices[0]?.message.tool_calls?.[0];
  assert.ok(toolCall, `expected tool_call on turn 1, got: ${JSON.stringify(turn1.response.choices[0]?.message)}`);
  assert.equal(toolCall.function.name, 'get_weather');

  const { body: body2 } = convertChatRequest(
    {
      model,
      messages: [
        { role: 'user', content: 'What is the weather in Sofia? Use the tool.' },
        {
          role: 'assistant',
          content: turn1.response.choices[0]?.message.content ?? null,
          tool_calls: [toolCall],
        },
        {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: FAKE_WEATHER_RESULT,
        },
      ],
      tools: [WEATHER_TOOL],
      max_completion_tokens: 256,
    },
    'openai',
  );
  const turn2 = await call(() => sendChatRequest({ apiKey, body: body2 }));

  const finalContent = turn2.response.choices[0]?.message.content;
  assert.ok(
    typeof finalContent === 'string' && finalContent.length > 0,
    `expected text content on turn 2, got: ${JSON.stringify(turn2.response.choices[0]?.message)}`,
  );
  const lower = finalContent.toLowerCase();
  assert.ok(
    lower.includes('22') || lower.includes('sunny') || lower.includes('warm') || lower.includes('clear'),
    `final answer does not mention the tool result. Got: "${finalContent}"`,
  );
  assertUsage(turn2.usage);
});
