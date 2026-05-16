/**
 * `response_format` integration tests — JSON mode.
 *
 * Verifies the library forwards the canonical `response_format` field
 * through to providers and that the model actually returns parseable
 * JSON. Two flavours:
 *
 *   - `response_format: { type: 'json_object' }` — "give me valid JSON"
 *     with no enforced schema. Supported natively by OpenAI, DeepSeek,
 *     Google (via OpenAI-compat), xAI, Kimi.
 *
 *   - `response_format: { type: 'json_schema', json_schema: { ... } }` —
 *     "give me JSON that validates against this schema". OpenAI is the
 *     gold standard here (strict-mode JSON schema). We test that
 *     specifically.
 *
 * Anthropic does not accept either of these shapes in the canonical
 * field directly — Anthropic's structured-output is a different
 * top-level `output_config` block. Forwarding `response_format` to
 * Anthropic would just drop it with a warning. So Anthropic is
 * deliberately not in this test file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sendChatRequest,
  convertChatRequest,
  DEEPSEEK_API_URL,
  GOOGLE_OPENAI_COMPAT_URL,
} from '../../src/index.js';
import { assertUsage, skipIfMissingKey, call } from './helpers.js';

const JSON_PROMPT = [
  {
    role: 'system' as const,
    content: 'You output JSON only. No prose. No code fences.',
  },
  {
    role: 'user' as const,
    content: 'Return an object with one key "city" whose value is "Sofia".',
  },
];

function assertParseableJsonContent(content: unknown, fieldHint: string): void {
  assert.equal(typeof content, 'string', `expected string content, got: ${JSON.stringify(content)}`);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content as string) as Record<string, unknown>;
  } catch (e) {
    assert.fail(
      `content is not parseable JSON: ${(e as Error).message}\ncontent: ${content as string}`,
    );
  }
  assert.equal(typeof parsed, 'object', 'parsed JSON is not an object');
  assert.ok(
    Object.prototype.hasOwnProperty.call(parsed, fieldHint),
    `expected key "${fieldHint}" in: ${JSON.stringify(parsed)}`,
  );
}

// ---------------------------------------------------------------------------
// json_object — multi-provider
// ---------------------------------------------------------------------------

test('openai — response_format json_object returns parseable JSON', skipIfMissingKey('OPENAI_API_KEY'), async () => {
  const { body } = convertChatRequest(
    {
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      messages: JSON_PROMPT,
      response_format: { type: 'json_object' },
      max_completion_tokens: 64,
    },
    'openai',
  );
  const { response, usage } = await call(() =>
    sendChatRequest({ apiKey: process.env.OPENAI_API_KEY!, body }),
  );
  assertParseableJsonContent(response.choices[0]?.message.content, 'city');
  assertUsage(usage);
});

test('google — response_format json_object returns parseable JSON', skipIfMissingKey('GOOGLE_API_KEY'), async () => {
  const { body } = convertChatRequest(
    {
      model: process.env.GOOGLE_MODEL ?? 'gemini-2.5-flash',
      messages: JSON_PROMPT,
      response_format: { type: 'json_object' },
      max_completion_tokens: 128,
    },
    'google',
  );
  const { response, usage } = await call(() =>
    sendChatRequest({
      apiKey: process.env.GOOGLE_API_KEY!,
      body,
      baseUrl: GOOGLE_OPENAI_COMPAT_URL,
    }),
  );
  assertParseableJsonContent(response.choices[0]?.message.content, 'city');
  assertUsage(usage);
});

test('deepseek — response_format json_object returns parseable JSON', skipIfMissingKey('DEEPSEEK_API_KEY'), async () => {
  const { body } = convertChatRequest(
    {
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
      messages: JSON_PROMPT,
      response_format: { type: 'json_object' },
      max_completion_tokens: 64,
    },
    'deepseek',
  );
  const { response, usage } = await call(() =>
    sendChatRequest({
      apiKey: process.env.DEEPSEEK_API_KEY!,
      body,
      baseUrl: DEEPSEEK_API_URL,
    }),
  );
  assertParseableJsonContent(response.choices[0]?.message.content, 'city');
  assertUsage(usage);
});

// ---------------------------------------------------------------------------
// json_schema — strict-mode (OpenAI's gold standard)
// ---------------------------------------------------------------------------

test('openai — response_format json_schema enforces the schema', skipIfMissingKey('OPENAI_API_KEY'), async () => {
  const { body } = convertChatRequest(
    {
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Reply with a JSON object matching the schema. No prose.' },
        { role: 'user', content: 'A weather snapshot for Sofia: 22 degrees, sunny.' },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'weather_snapshot',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['city', 'temperature_c', 'conditions'],
            properties: {
              city: { type: 'string' },
              temperature_c: { type: 'number' },
              conditions: { type: 'string' },
            },
          },
        },
      },
      max_completion_tokens: 96,
    },
    'openai',
  );
  const { response, usage } = await call(() =>
    sendChatRequest({ apiKey: process.env.OPENAI_API_KEY!, body }),
  );

  const content = response.choices[0]?.message.content;
  assert.equal(typeof content, 'string', `expected string content, got ${typeof content}`);
  const parsed = JSON.parse(content as string) as {
    city: string;
    temperature_c: number;
    conditions: string;
  };
  assert.equal(typeof parsed.city, 'string', `city is ${typeof parsed.city}, expected string`);
  assert.equal(typeof parsed.temperature_c, 'number', `temperature_c is ${typeof parsed.temperature_c}, expected number`);
  assert.equal(typeof parsed.conditions, 'string', `conditions is ${typeof parsed.conditions}, expected string`);
  assertUsage(usage);
});
