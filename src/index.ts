/**
 * @encorp.ai/llm-open-proxy — OpenAI-canonical chat translator for LLM providers.
 *
 * Three layers of API, pick whatever fits:
 *
 *  1. Pure conversion — give it a canonical request + a provider name, get
 *     back a provider-shaped body. No HTTP, no I/O. Best for users who
 *     already have their own transport.
 *
 *       import { convertChatRequest } from '@encorp.ai/llm-open-proxy';
 *       const { body, warnings } = convertChatRequest(canonical, 'anthropic');
 *
 *  2. Transport — convenience wrappers that handle HTTP + response
 *     translation. Returns the response in canonical (OpenAI) shape
 *     regardless of the upstream.
 *
 *       import {
 *         sendChatRequest,           // OpenAI-shaped providers (openai/google/...)
 *         sendAnthropicRequest,      // Anthropic-shaped provider
 *       } from '@encorp.ai/llm-open-proxy';
 *
 *  3. Tree-shakeable submodules — import a single provider's adapter when
 *     you only care about one upstream:
 *
 *       import { anthropicChatConfig, toAnthropicRequest } from
 *         '@encorp.ai/llm-open-proxy/providers/anthropic';
 */

// Public types
export type {
  ProviderName,
  Role,
  ContentPart,
  ChatMessage,
  ChatTool,
  ChatToolCall,
  ChatToolChoice,
  ChatToolFunction,
  ResponseFormat,
  ResponseFormatJsonSchema,
  CanonicalChatRequest,
  CanonicalChatResponse,
  TokenUsage,
} from './types.js';

// Engine
export type { MapAction, ProviderParamConfig, TransformCtx, TransformResult } from './engine.js';
export { transformChatRequest } from './engine.js';

// Helpers (re-exported for users building their own configs)
export {
  resolveMaxCompletionTokens,
  stripReasoningContent,
  extractSystemMessages,
  clampTemperature,
  modelMatches,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_THINKING_BUDGET,
} from './helpers.js';

// Errors + retry
export { UpstreamError } from './errors.js';
export { isRetryableUpstreamStatus } from './retry.js';

// Provider configs + resolver
export {
  getProviderConfig,
  openaiChatConfig,
  googleChatConfig,
  anthropicChatConfig,
  deepseekChatConfig,
  perplexityChatConfig,
} from './providers/index.js';

// Transport — OpenAI-shaped providers
export {
  sendChatRequest,
  streamChatRequest,
  OPENAI_API_URL,
  GOOGLE_OPENAI_COMPAT_URL,
  XAI_API_URL,
  DEEPSEEK_API_URL,
  KIMI_API_URL,
  PERPLEXITY_API_URL,
} from './providers/openai.js';
export type {
  SendOptions,
  SendResult,
  StreamResult,
} from './providers/openai.js';

// Transport — Anthropic
export {
  sendAnthropicRequest,
  streamAnthropicRequest,
  toAnthropicRequest,
  toCanonicalResponse,
} from './providers/anthropic.js';
export type {
  AnthropicSendOptions,
  AnthropicSendResult,
  AnthropicStreamResult,
  AnthropicRequest,
  RequestTranslationResult,
} from './providers/anthropic.js';

// ---------------------------------------------------------------------------
// High-level convenience: convertChatRequest()
// ---------------------------------------------------------------------------

import type { CanonicalChatRequest, ProviderName } from './types.js';
import { transformChatRequest as _transform } from './engine.js';
import { getProviderConfig as _resolve } from './providers/index.js';
import {
  toAnthropicRequest as _toAnthropic,
  type AnthropicRequest as _AnthropicRequest,
} from './providers/anthropic.js';
import { stripReasoningContent } from './helpers.js';

export interface ConvertResult {
  /** The upstream-ready body. For Anthropic this is the Messages API shape. */
  body: Record<string, unknown>;
  /** Fields that were dropped, renamed, or clamped during translation. */
  warnings: string[];
}

/**
 * One-call conversion: canonical OpenAI request → provider-specific body.
 * Handles Anthropic's message reshape internally.
 */
export function convertChatRequest(
  canonical: CanonicalChatRequest,
  provider: ProviderName,
): ConvertResult {
  if (provider === 'anthropic') {
    const { request, warnings } = _toAnthropic(canonical);
    return { body: request as unknown as Record<string, unknown>, warnings };
  }

  const prepared = provider === 'deepseek'
    ? canonical
    : { ...canonical, messages: stripReasoningContent(canonical.messages) };

  const { config, canonicalProvider } = _resolve(provider);
  return _transform(prepared, config, canonicalProvider);
}

// Internal-only re-export kept so the convert helper has access without
// pulling provider modules into the type position of the public surface.
export type { _AnthropicRequest as _AnthropicRequestInternal };
