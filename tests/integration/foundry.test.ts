/**
 * Microsoft Foundry integration tests.
 *
 * One Foundry resource serves several wire protocols, so this file covers
 * each surface the adapter speaks:
 *
 *   - `openai-v1` (default): basic, streaming, tool calling
 *   - `openai-deployments`: the dated Azure OpenAI API on the same deployment
 *   - `anthropic`: Claude on Foundry, basic + streaming (opt-in, needs a
 *     Claude deployment)
 *   - reasoning: a non-OpenAI reasoning deployment (e.g. DeepSeek-R1) must
 *     surface `reasoning_content`, whether the service returns it natively or
 *     inline as `<think>` tags (opt-in)
 *
 * Required: FOUNDRY_ENDPOINT (e.g. https://my-res.services.ai.azure.com)
 * and FOUNDRY_API_KEY. `model` is the *deployment* name.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendFoundryRequest, streamFoundryRequest } from '../../src/index.js';
import {
  WEATHER_TOOL,
  assertCanonicalResponse,
  assertToolCall,
  assertUsage,
  buildMinimalRequest,
  collectSseContent,
  call,
} from './helpers.js';

const endpoint = process.env.FOUNDRY_ENDPOINT ?? '';
const apiKey = process.env.FOUNDRY_API_KEY ?? '';
const model = process.env.FOUNDRY_MODEL ?? 'gpt-4o-mini';
const claudeModel = process.env.FOUNDRY_CLAUDE_MODEL ?? '';
const reasonerModel = process.env.FOUNDRY_REASONER_MODEL ?? '';

/** Skip unless every listed env var is set. */
function skipUnless(...names: string[]): { skip?: string } {
  const missing = names.filter((n) => !process.env[n]);
  return missing.length > 0 ? { skip: `set ${missing.join(' and ')} to run this test` } : {};
}

const target = { endpoint, apiKey };

test('foundry v1 — basic request returns canonical response', skipUnless('FOUNDRY_ENDPOINT', 'FOUNDRY_API_KEY'), async () => {
  const { response, usage } = await call(() =>
    sendFoundryRequest({ ...target, body: buildMinimalRequest(model) }),
  );
  assertCanonicalResponse(response);
  assertUsage(usage);
});

test('foundry v1 — streaming yields content and usage', skipUnless('FOUNDRY_ENDPOINT', 'FOUNDRY_API_KEY'), async () => {
  const { stream, getUsage } = await call(() =>
    streamFoundryRequest({ ...target, body: buildMinimalRequest(model) }),
  );
  const content = await collectSseContent(stream);
  assert.ok(content.length > 0, 'expected at least one content delta');
  assert.ok(getUsage().completion_tokens > 0, `expected usage, got ${JSON.stringify(getUsage())}`);
});

test('foundry v1 — tool call round-trips to canonical tool_calls', skipUnless('FOUNDRY_ENDPOINT', 'FOUNDRY_API_KEY'), async () => {
  const { response, usage } = await call(() =>
    sendFoundryRequest({
      ...target,
      body: {
        model,
        messages: [{ role: 'user', content: 'What is the weather in Sofia right now?' }],
        tools: [WEATHER_TOOL],
        tool_choice: 'required',
        max_completion_tokens: 128,
      },
    }),
  );
  assertToolCall(response, 'get_weather', 'Sofia');
  assert.equal(response.choices[0]!.finish_reason, 'tool_calls');
  assertUsage(usage);
});

test('foundry dated API — deployment-scoped request returns canonical response', skipUnless('FOUNDRY_ENDPOINT', 'FOUNDRY_API_KEY'), async () => {
  const { response } = await call(() =>
    sendFoundryRequest({ ...target, api: 'openai-deployments', body: buildMinimalRequest(model) }),
  );
  assertCanonicalResponse(response);
});

test('foundry claude — basic request returns canonical response', skipUnless('FOUNDRY_ENDPOINT', 'FOUNDRY_API_KEY', 'FOUNDRY_CLAUDE_MODEL'), async () => {
  const { response, usage } = await call(() =>
    sendFoundryRequest({ ...target, api: 'anthropic', body: buildMinimalRequest(claudeModel) }),
  );
  assertCanonicalResponse(response);
  assertUsage(usage);
});

test('foundry claude — streaming bridges to OpenAI SSE', skipUnless('FOUNDRY_ENDPOINT', 'FOUNDRY_API_KEY', 'FOUNDRY_CLAUDE_MODEL'), async () => {
  const { stream } = await call(() =>
    streamFoundryRequest({ ...target, api: 'anthropic', body: buildMinimalRequest(claudeModel) }),
  );
  const content = await collectSseContent(stream);
  assert.ok(content.length > 0, 'expected at least one content delta');
});

test('foundry reasoner — surfaces reasoning_content', skipUnless('FOUNDRY_ENDPOINT', 'FOUNDRY_API_KEY', 'FOUNDRY_REASONER_MODEL'), async () => {
  const { response } = await call(() =>
    sendFoundryRequest({
      ...target,
      body: {
        model: reasonerModel,
        messages: [{ role: 'user', content: 'What is 17 * 23? Think step by step, then give the final number.' }],
        max_completion_tokens: 2048,
      },
    }),
  );
  const message = response.choices[0]!.message;
  assert.ok(
    typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0,
    `expected reasoning_content, got: ${JSON.stringify(message, null, 2)}`,
  );
  assert.ok(!String(message.content).includes('<think>'), 'think tags must not leak into content');
});
