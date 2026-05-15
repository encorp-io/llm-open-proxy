/**
 * OpenAI provider — canonical passthrough.
 *
 * The library's canonical format IS OpenAI Chat Completions, so the param
 * config is mostly passthrough. The only special handling is for the
 * GPT-5 / o-series models that reject `temperature` and `top_p`.
 *
 * The same transport works for any OpenAI-compatible HTTP endpoint —
 * `sendChatRequest` accepts an optional `baseUrl` so it can be reused by
 * Google (OpenAI-compat URL), xAI, DeepSeek, Kimi, Perplexity.
 */

import type {
  CanonicalChatRequest,
  CanonicalChatResponse,
  TokenUsage,
} from '../types.js';
import type { ProviderParamConfig } from '../engine.js';
import { resolveMaxCompletionTokens, modelMatches } from '../helpers.js';
import { UpstreamError } from '../errors.js';

export const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

/** Models that reject `temperature` and `top_p` (only the model default is accepted). */
const SAMPLING_LOCKED_PREFIXES = ['gpt-5', 'o1', 'o3', 'o4'] as const;

export const openaiChatConfig: ProviderParamConfig = {
  temperature: {
    kind: 'custom',
    apply(body, value, ctx) {
      if (modelMatches(ctx.fullRequest.model, SAMPLING_LOCKED_PREFIXES)) {
        ctx.warn(`temperature unsupported on ${ctx.fullRequest.model} -- dropped (model uses fixed default)`);
        return;
      }
      body.temperature = value;
    },
  },
  top_p: {
    kind: 'custom',
    apply(body, value, ctx) {
      if (modelMatches(ctx.fullRequest.model, SAMPLING_LOCKED_PREFIXES)) {
        ctx.warn(`top_p unsupported on ${ctx.fullRequest.model} -- dropped`);
        return;
      }
      body.top_p = value;
    },
  },
  top_k: { kind: 'drop', reason: 'OpenAI does not support top_k' },
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
  logit_bias: { kind: 'passthrough' },
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

// ---------------------------------------------------------------------------
// Transport (shared by every OpenAI-compatible provider)
// ---------------------------------------------------------------------------

export interface SendOptions {
  apiKey: string;
  body: Record<string, unknown>;
  baseUrl?: string;
  /** Per-request abort. */
  signal?: AbortSignal;
  /** Default 10 minutes. */
  timeoutMs?: number;
  /** Extra headers (e.g. Anthropic-style x-api-key proxies). */
  headers?: Record<string, string>;
}

export interface SendResult {
  response: CanonicalChatResponse;
  usage: TokenUsage;
}

export interface StreamResult {
  stream: ReadableStream<Uint8Array>;
  getUsage: () => TokenUsage;
}

const DEFAULT_TIMEOUT_MS = 600_000;

export async function sendChatRequest(opts: SendOptions): Promise<SendResult> {
  const url = opts.baseUrl ?? OPENAI_API_URL;
  const res = await openaiFetch(url, opts, { ...opts.body, stream: false });

  const data = (await res.json()) as CanonicalChatResponse;
  return {
    response: data,
    usage: {
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
      total_tokens: data.usage?.total_tokens ?? 0,
    },
  };
}

export async function streamChatRequest(opts: SendOptions): Promise<StreamResult> {
  const url = opts.baseUrl ?? OPENAI_API_URL;
  const res = await openaiFetch(url, opts, {
    ...opts.body,
    stream: true,
    stream_options: { include_usage: true },
  });

  if (!res.body) {
    throw new UpstreamError('No response body from upstream', 502);
  }

  const usage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const decoder = new TextDecoder();

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const parsed = JSON.parse(line.slice(6)) as { usage?: TokenUsage };
            if (parsed.usage) {
              usage.prompt_tokens = parsed.usage.prompt_tokens ?? 0;
              usage.completion_tokens = parsed.usage.completion_tokens ?? 0;
              usage.total_tokens = parsed.usage.total_tokens ?? 0;
            }
          } catch {
            // partial chunk — ignore
          }
        }
      }
      controller.enqueue(chunk);
    },
  });

  return {
    stream: res.body.pipeThrough(transform),
    getUsage: () => usage,
  };
}

async function openaiFetch(
  url: string,
  opts: SendOptions,
  body: Record<string, unknown>,
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
        ...(opts.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new UpstreamError(`Request timed out after ${timeoutMs}ms`, 504);
    }
    throw err;
  }

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({} as unknown));
    const message =
      (errorBody as { error?: { message?: string } })?.error?.message ?? `Upstream error ${res.status}`;
    throw new UpstreamError(message, res.status, errorBody);
  }

  return res;
}

// ---------------------------------------------------------------------------
// Compatible base URLs for OpenAI-shaped providers
// ---------------------------------------------------------------------------

export const GOOGLE_OPENAI_COMPAT_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
export const XAI_API_URL = 'https://api.x.ai/v1/chat/completions';
export const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
export const KIMI_API_URL = 'https://api.moonshot.cn/v1/chat/completions';
export const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';

// Marker for unused param in declarative-config blocks above.
export type { CanonicalChatRequest };
