/**
 * Reasoning-model integration tests.
 *
 * Currently focused on DeepSeek's `deepseek-reasoner`, which is the only
 * provider where reasoning content surfaces in the canonical response
 * shape — on `choices[0].message.reasoning_content`. This is by design:
 *
 *   - OpenAI o-series: thinking is internal, never exposed by the API.
 *   - Anthropic: returns `thinking` content blocks, but the library
 *     currently filters them out in `toCanonicalResponse` (it only
 *     keeps `text` and `tool_use`). TODO: surface them as
 *     `reasoning_content` for parity with DeepSeek.
 *   - Gemini: thinking is internal unless `include_thoughts` is set,
 *     which we don't currently wire through.
 *
 * So for now: one solid test against DeepSeek to prove `reasoning_content`
 * round-trips. When the Anthropic gap is closed, add a sibling test
 * here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sendChatRequest,
  convertChatRequest,
  DEEPSEEK_API_URL,
} from '../../src/index.js';
import {
  assertCanonicalResponse,
  assertUsage,
  skipIfMissingKey,
  call,
} from './helpers.js';

const deepseekKey = process.env.DEEPSEEK_API_KEY ?? '';
// `deepseek-reasoner` is the thinking variant. The default `deepseek-chat`
// model does NOT return reasoning_content, so use the reasoner explicitly.
const reasonerModel = process.env.DEEPSEEK_REASONER_MODEL ?? 'deepseek-reasoner';

test('deepseek-reasoner — populates reasoning_content on assistant message', skipIfMissingKey('DEEPSEEK_API_KEY'), async () => {
  // A question that nudges the model to actually think before answering.
  // Short enough that the visible output stays small; reasoning_content
  // is where the bulk of tokens will land.
  const { body } = convertChatRequest(
    {
      model: reasonerModel,
      messages: [
        {
          role: 'user',
          content: 'What is 17 * 23? Think step by step, then give the final number.',
        },
      ],
      reasoning_effort: 'low',
      // Reasoners need real headroom — thinking tokens come on top of
      // visible output. 512 keeps the call cheap (~$0.001) while leaving
      // room for a chain-of-thought.
      max_completion_tokens: 512,
    },
    'deepseek',
  );

  const { response, usage } = await call(() =>
    sendChatRequest({
      apiKey: deepseekKey,
      body,
      baseUrl: DEEPSEEK_API_URL,
    }),
  );

  assertCanonicalResponse(response);
  assertUsage(usage);

  const message = response.choices[0]?.message;
  assert.ok(message, 'choice.message missing');

  // The headline assertion: DeepSeek's reasoning_content survives the
  // round-trip and lands on the canonical message exactly as the type
  // definition promises.
  const reasoning = message.reasoning_content;
  assert.equal(
    typeof reasoning,
    'string',
    `expected reasoning_content: string, got: ${JSON.stringify(reasoning)}\nfull message: ${JSON.stringify(message, null, 2)}`,
  );
  assert.ok(
    (reasoning as string).length > 0,
    `reasoning_content is an empty string — model returned no chain of thought`,
  );
});
