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
} from './helpers.js';
import assert from 'node:assert/strict';

const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
const model = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5';

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
