import { test } from 'node:test';
import {
  sendAnthropicRequest,
  streamAnthropicRequest,
} from '../../src/index.js';
import {
  buildMinimalRequest,
  assertCanonicalResponse,
  assertUsage,
  skipIfMissingKey,
  collectSseContent,
  call,
  DEFAULT_ANTHROPIC_MODEL,
} from './helpers.js';
import assert from 'node:assert/strict';

const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;

test('anthropic — basic request returns OpenAI-shape response', skipIfMissingKey('ANTHROPIC_API_KEY'), async () => {
  const { response, usage, warnings } = await call(() =>
    sendAnthropicRequest({
      apiKey,
      body: buildMinimalRequest(model),
    }),
  );

  assertCanonicalResponse(response);
  assertUsage(usage);
  assert.ok(Array.isArray(warnings), 'warnings is not an array');
});

test('anthropic — system message extraction round-trips', skipIfMissingKey('ANTHROPIC_API_KEY'), async () => {
  // Anthropic puts `system` at the top level, not in messages. The library
  // extracts it on the way out and reattaches on the way back.
  const { response, usage } = await call(() =>
    sendAnthropicRequest({
      apiKey,
      body: {
        model,
        messages: [
          { role: 'system', content: 'You answer with exactly one word: bulgaria.' },
          { role: 'user', content: 'Where do you live?' },
        ],
        max_completion_tokens: 32,
      },
    }),
  );

  assertCanonicalResponse(response);
  assertUsage(usage);
});

test('anthropic — streaming yields OpenAI-format SSE chunks', skipIfMissingKey('ANTHROPIC_API_KEY'), async () => {
  const { stream, getUsage } = await call(() =>
    streamAnthropicRequest({
      apiKey,
      body: {
        ...buildMinimalRequest(model),
        stream: true,
      },
    }),
  );

  const content = await collectSseContent(stream);
  assert.ok(content.length > 0, 'no content delta accumulated from stream');

  const usage = getUsage();
  assertUsage(usage);
  // Streaming usage should report at least some output tokens once the
  // `message_delta` event has fired.
  assert.ok(usage.completion_tokens > 0, 'stream completed but completion_tokens=0');
});

test('anthropic — sampling controls and reasoning_effort are adapted to the model family', skipIfMissingKey('ANTHROPIC_API_KEY'), async () => {
  // Current Claude families reject temperature/top_p/top_k and budget
  // thinking; older ones reject sampling controls alongside budget thinking.
  // Either way the translator must produce a request the model accepts, with
  // output_config.effort merged next to output_config.format.
  const { response, warnings } = await call(() =>
    sendAnthropicRequest({
      apiKey,
      body: {
        model,
        messages: [{ role: 'user', content: 'Give the capital of Bulgaria.' }],
        temperature: 0.5,
        top_p: 0.9,
        top_k: 40,
        reasoning_effort: 'low',
        max_completion_tokens: 2048,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'capital',
            schema: {
              type: 'object',
              properties: { capital: { type: 'string' } },
              required: ['capital'],
              additionalProperties: false,
            },
          },
        },
      },
    }),
  );

  assertCanonicalResponse(response);
  const parsed = JSON.parse(response.choices[0]!.message.content as string) as { capital?: unknown };
  assert.equal(typeof parsed.capital, 'string');
  assert.ok(warnings.some((w) => /'temperature'.*dropped/.test(w)), `expected a temperature warning, got ${JSON.stringify(warnings)}`);
});
