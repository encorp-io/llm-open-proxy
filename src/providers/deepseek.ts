/**
 * DeepSeek provider — OpenAI-shape transport, custom reasoning-effort
 * mapping, and `reasoning_content` preservation on assistant messages.
 */

import type { ProviderParamConfig } from '../engine.js';
import { resolveMaxCompletionTokens } from '../helpers.js';

export const deepseekChatConfig: ProviderParamConfig = {
  temperature: { kind: 'passthrough' },
  top_p: { kind: 'passthrough' },
  top_k: { kind: 'drop', reason: 'DeepSeek does not support top_k' },
  n: { kind: 'drop', reason: 'DeepSeek only supports n=1' },
  max_completion_tokens: { kind: 'rename', to: 'max_tokens' },
  max_tokens: {
    kind: 'custom',
    apply(body, _value, ctx) {
      const resolved = resolveMaxCompletionTokens(ctx.fullRequest);
      if (resolved !== undefined) body.max_tokens = resolved;
    },
  },
  stop: { kind: 'passthrough' },
  frequency_penalty: { kind: 'drop', reason: 'deprecated on DeepSeek v4' },
  presence_penalty: { kind: 'drop', reason: 'deprecated on DeepSeek v4' },
  logit_bias: { kind: 'drop', reason: 'DeepSeek does not support logit_bias' },
  seed: { kind: 'drop', reason: 'DeepSeek does not support seed' },
  user: { kind: 'rename', to: 'user_id' },
  logprobs: { kind: 'passthrough' },
  top_logprobs: { kind: 'passthrough' },
  response_format: { kind: 'passthrough' },
  tools: { kind: 'passthrough' },
  tool_choice: { kind: 'passthrough' },
  parallel_tool_calls: { kind: 'drop', reason: 'DeepSeek does not expose parallel_tool_calls' },
  reasoning_effort: {
    kind: 'custom',
    apply(body, value) {
      const v = String(value);
      const effort = v === 'high' || v === 'medium' ? 'high' : 'max';
      body.thinking = { type: 'enabled', reasoning_effort: effort };
    },
  },
  stream: { kind: 'passthrough' },
  stream_options: { kind: 'passthrough' },
};
