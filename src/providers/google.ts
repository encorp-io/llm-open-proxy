/**
 * Google Gemini provider — uses Gemini's OpenAI-compatibility endpoint so
 * the transport from openai.ts works as-is. Only a couple of fields differ.
 */

import type { ProviderParamConfig } from '../engine.js';
import { resolveMaxCompletionTokens } from '../helpers.js';

export const googleChatConfig: ProviderParamConfig = {
  temperature: { kind: 'passthrough' },
  top_p: { kind: 'passthrough' },
  top_k: { kind: 'passthrough' },
  n: { kind: 'passthrough' },
  max_completion_tokens: { kind: 'passthrough' },
  max_tokens: {
    kind: 'custom',
    apply(body, _value, ctx) {
      const resolved = resolveMaxCompletionTokens(ctx.fullRequest);
      if (resolved !== undefined) body.max_completion_tokens = resolved;
    },
  },
  stop: { kind: 'passthrough' },
  frequency_penalty: { kind: 'passthrough' },
  presence_penalty: { kind: 'passthrough' },
  logit_bias: { kind: 'drop', reason: 'Gemini OpenAI-compat does not accept logit_bias' },
  seed: { kind: 'passthrough' },
  user: { kind: 'passthrough' },
  logprobs: { kind: 'passthrough' },
  top_logprobs: { kind: 'passthrough' },
  response_format: { kind: 'passthrough' },
  tools: { kind: 'passthrough' },
  tool_choice: { kind: 'passthrough' },
  parallel_tool_calls: { kind: 'passthrough' },
  reasoning_effort: { kind: 'passthrough' },
  stream: { kind: 'passthrough' },
  stream_options: { kind: 'passthrough' },
};
