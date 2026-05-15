/**
 * Perplexity provider — OpenAI-shape transport, but several sampling
 * parameters are unsupported and dropped with warnings.
 */

import type { ProviderParamConfig } from '../engine.js';
import { resolveMaxCompletionTokens } from '../helpers.js';

export const perplexityChatConfig: ProviderParamConfig = {
  temperature: { kind: 'passthrough' },
  top_p: { kind: 'passthrough' },
  top_k: { kind: 'drop', reason: 'Perplexity does not support top_k' },
  n: { kind: 'drop', reason: 'Perplexity only supports n=1' },
  max_completion_tokens: { kind: 'rename', to: 'max_tokens' },
  max_tokens: {
    kind: 'custom',
    apply(body, _value, ctx) {
      const resolved = resolveMaxCompletionTokens(ctx.fullRequest);
      if (resolved !== undefined) body.max_tokens = resolved;
    },
  },
  stop: { kind: 'passthrough' },
  frequency_penalty: { kind: 'drop', reason: 'Perplexity does not support frequency_penalty' },
  presence_penalty: { kind: 'drop', reason: 'Perplexity does not support presence_penalty' },
  logit_bias: { kind: 'drop', reason: 'Perplexity does not support logit_bias' },
  seed: { kind: 'drop', reason: 'Perplexity does not support seed' },
  user: { kind: 'passthrough' },
  logprobs: { kind: 'drop', reason: 'Perplexity does not support logprobs' },
  top_logprobs: { kind: 'drop', reason: 'Perplexity does not support top_logprobs' },
  response_format: { kind: 'passthrough' },
  tools: { kind: 'passthrough' },
  tool_choice: { kind: 'drop', reason: 'Perplexity does not support tool_choice' },
  parallel_tool_calls: { kind: 'drop', reason: 'Perplexity does not support parallel_tool_calls' },
  reasoning_effort: { kind: 'passthrough' },
  stream: { kind: 'passthrough' },
  stream_options: { kind: 'passthrough' },
};
