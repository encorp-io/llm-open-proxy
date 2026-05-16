/**
 * Shared assertions and request builders for integration tests.
 *
 * Keep payloads as small as possible — every test costs real money.
 */

import assert from 'node:assert/strict';
import {
  UpstreamError,
  type CanonicalChatRequest,
  type CanonicalChatResponse,
  type TokenUsage,
} from '../../src/index.js';

/**
 * Wrap an async call so that an `UpstreamError` is reported as a
 * test failure with the full upstream body inlined. Node's test runner
 * truncates nested error properties to `[Object]` in its default
 * reporter, which hides the actual upstream error message — this wrapper
 * works around that by re-throwing as a plain Error whose message
 * contains the body verbatim.
 *
 *   const result = await call(() => sendChatRequest({ ... }));
 */
export async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UpstreamError) {
      // UpstreamError.toString() now includes the body; surface it as
      // the assertion message so the test runner prints it.
      throw new Error(e.toString());
    }
    throw e;
  }
}

/**
 * Build the smallest meaningful chat request: one system message, one
 * user message, capped at ~10 output tokens.
 */
export function buildMinimalRequest(model: string): CanonicalChatRequest {
  return {
    model,
    messages: [
      { role: 'system', content: 'Reply with a single short word.' },
      { role: 'user', content: 'Hi' },
    ],
    // 64 not 10: reasoning models (Gemini 2.5 Flash, o-series, etc.)
    // burn the early tokens on internal thinking. 64 gives enough headroom
    // for them to emit at least one visible token without blowing up the
    // bill. A full run of the suite is still well under a cent.
    max_completion_tokens: 64,
  };
}

/**
 * Assert the canonical response shape (OpenAI Chat Completions).
 * Catches translation regressions where a provider's response failed to
 * round-trip back to canonical shape.
 */
export function assertCanonicalResponse(response: CanonicalChatResponse): void {
  assert.ok(response, 'response is null/undefined');
  assert.ok(Array.isArray(response.choices), '`choices` is not an array');
  assert.ok(response.choices.length > 0, '`choices` is empty');

  const choice = response.choices[0]!;
  assert.ok(choice.message, 'choice.message missing');
  assert.equal(choice.message.role, 'assistant', 'choice.message.role !== assistant');

  // Content can be string OR array of content parts; both are valid.
  const content = choice.message.content;
  const hasContent =
    (typeof content === 'string' && content.length > 0) ||
    (Array.isArray(content) && content.length > 0);

  if (!hasContent) {
    // Diagnostic: show finish_reason + usage so we can tell whether the
    // upstream tripped a safety filter, hit a token limit (esp. a thinking
    // model burning its budget on reasoning), or returned a genuine empty
    // response.
    const diag = {
      content,
      finish_reason: choice.finish_reason,
      usage: response.usage,
      model: response.model,
    };
    assert.fail(`choice.message.content is empty: ${JSON.stringify(diag, null, 2)}`);
  }
}

/**
 * Assert usage tokens look sane.
 */
export function assertUsage(usage: TokenUsage): void {
  assert.ok(typeof usage.prompt_tokens === 'number', '`usage.prompt_tokens` not a number');
  assert.ok(typeof usage.completion_tokens === 'number', '`usage.completion_tokens` not a number');
  assert.ok(typeof usage.total_tokens === 'number', '`usage.total_tokens` not a number');
  assert.ok(usage.prompt_tokens >= 0, '`usage.prompt_tokens` negative');
  assert.ok(usage.completion_tokens >= 0, '`usage.completion_tokens` negative');
  // Some providers report total_tokens=0 if a request errors mid-stream; we
  // only assert non-negative, not strictly positive.
  assert.ok(usage.total_tokens >= 0, '`usage.total_tokens` negative');
}

/**
 * Build a skip directive for `node --test`. If `apiKey` is missing,
 * returns `{ skip: '<reason>' }`. Otherwise returns `{}`.
 */
export function skipIfMissingKey(envName: string): { skip?: string } {
  const value = process.env[envName];
  if (!value) {
    return { skip: `set ${envName} to run this test` };
  }
  return {};
}

/**
 * Definition of a tiny weather tool used by the tool-calling integration
 * tests. Each provider gets the same tool — the test verifies that the
 * library forwards it correctly and that the model's tool_call response
 * round-trips back to canonical (OpenAI) shape.
 */
export const WEATHER_TOOL = {
  type: 'function' as const,
  function: {
    name: 'get_weather',
    description: 'Look up the current weather for a city. Always call this when the user asks about weather.',
    parameters: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: 'City name, e.g. "Sofia" or "Berlin".',
        },
      },
      required: ['city'],
    },
  },
};

/**
 * Assert that the model returned a tool_call to `expectedName` and that
 * the JSON-stringified arguments mention `expectedCity` (case-insensitive
 * substring match, since models phrase the city slightly differently —
 * e.g. "Sofia, Bulgaria" or just "Sofia").
 */
export function assertToolCall(
  response: CanonicalChatResponse,
  expectedName: string,
  expectedCity: string,
): void {
  const message = response.choices[0]?.message;
  assert.ok(message, 'choice.message missing');
  const toolCalls = message.tool_calls;
  assert.ok(
    Array.isArray(toolCalls) && toolCalls.length > 0,
    `expected tool_calls array, got: ${JSON.stringify(message, null, 2)}`,
  );

  const call = toolCalls[0]!;
  assert.equal(call.type, 'function', 'tool_call.type !== function');
  assert.equal(
    call.function.name,
    expectedName,
    `tool_call.function.name: expected "${expectedName}", got "${call.function.name}"`,
  );

  // Parse args and check the city slot is filled. Models may return either
  // a JSON-string or an already-parsed object on some providers — handle both.
  let args: unknown;
  try {
    args = typeof call.function.arguments === 'string'
      ? JSON.parse(call.function.arguments)
      : call.function.arguments;
  } catch (e) {
    assert.fail(`tool_call.function.arguments is not valid JSON: ${call.function.arguments}`);
  }

  const city = (args as { city?: unknown }).city;
  assert.equal(typeof city, 'string', `args.city is not a string: ${JSON.stringify(args)}`);
  assert.ok(
    (city as string).toLowerCase().includes(expectedCity.toLowerCase()),
    `args.city does not include "${expectedCity}": got "${city as string}"`,
  );
}

/**
 * Tiny 1x1 transparent PNG, base64-encoded as a data URI. Used by the
 * multimodal integration tests to verify the library forwards
 * `image_url` content parts correctly without making us depend on an
 * external URL that could rot.
 *
 * Some vision models reject single-pixel inputs as "too small to
 * describe"; that's fine for our purposes because we're testing the
 * *wire-format translation*, not the model's vision quality. The test
 * passes if the call succeeds and the response is OpenAI-shape — we
 * don't assert on the response text.
 */
export const TINY_IMAGE_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/**
 * Collect all tool_call deltas from an OpenAI-format SSE stream, keyed
 * by call index. Returns an array of fully-assembled tool calls. Used
 * by the streaming-tools tests to verify that the library accumulates
 * tool_call argument fragments across SSE chunks without corruption —
 * a classic place for off-by-one or partial-JSON bugs.
 */
export async function collectSseToolCalls(
  stream: ReadableStream<Uint8Array>,
): Promise<Array<{ id?: string; name?: string; arguments: string }>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const acc = new Map<number, { id?: string; name?: string; arguments: string }>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]' || payload === '') continue;

        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{
              delta?: {
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
          };
          const calls = json.choices?.[0]?.delta?.tool_calls;
          if (!Array.isArray(calls)) continue;
          for (const tc of calls) {
            const existing = acc.get(tc.index) ?? { arguments: '' };
            if (tc.id !== undefined) existing.id = tc.id;
            if (tc.function?.name !== undefined) existing.name = tc.function.name;
            if (tc.function?.arguments !== undefined) {
              existing.arguments += tc.function.arguments;
            }
            acc.set(tc.index, existing);
          }
        } catch {
          // ignore non-JSON keep-alives
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return [...acc.entries()].sort(([a], [b]) => a - b).map(([, v]) => v);
}

/**
 * Collect all text content from an OpenAI-format SSE stream. Returns
 * the concatenated content delta payload across all chunks.
 */
export async function collectSseContent(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE chunks are split by double-newline; lines within start with `data: `.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // keep trailing partial line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]' || payload === '') continue;

        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') content += delta;
        } catch {
          // SSE keep-alives or non-JSON payloads — ignore.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return content;
}
