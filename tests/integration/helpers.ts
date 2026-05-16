/**
 * Shared assertions and request builders for integration tests.
 *
 * Keep payloads as small as possible — every test costs real money.
 */

import assert from 'node:assert/strict';
import type {
  CanonicalChatRequest,
  CanonicalChatResponse,
  TokenUsage,
} from '../../src/index.js';

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
    // 32 not 10: gives reasoning models (Gemini 2.5 Flash, o-series, etc.)
    // some headroom for thinking tokens before any visible content is emitted.
    // Still costs a fraction of a cent per call.
    max_completion_tokens: 32,
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
