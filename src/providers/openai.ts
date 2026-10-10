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
import type { MapAction, ProviderParamConfig } from '../engine.js';
import { resolveMaxCompletionTokens } from '../helpers.js';
import { UpstreamError } from '../errors.js';
import { parseRetryAfterMs } from '../retry.js';

export const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

// ---------------------------------------------------------------------------
// Reasoning-model rules (shared with the Microsoft Foundry adapter, which
// serves the same OpenAI models)
// ---------------------------------------------------------------------------

interface ReasoningProfile {
  /**
   * Lowest `reasoning_effort` accepted. No model takes both 'none' and
   * 'minimal', so whichever of the two it lacks is sent as this level. Unset:
   * unknown, and `reasoning_effort` is never rewritten.
   */
  minEffort?: 'none' | 'minimal' | 'low';
  /** Highest level accepted when the model has no 'xhigh'. */
  maxEffort?: 'high';
  /** Reasons only when asked: an omitted `reasoning_effort` means 'none'. */
  defaultNone?: boolean;
  /** Accepts `stop`. */
  stop?: boolean;
  /**
   * Function tools on Chat Completions. 'no-reasoning': only alongside effort
   * 'none'. 'never': Responses API only, so the upstream rejects the request.
   * Unset: tools work at any effort.
   */
  tools?: 'no-reasoning' | 'never';
}

/**
 * How each reasoning-model family behaves on Chat Completions; the first
 * matching id prefix wins. Every non-empty row was verified live against
 * OpenAI on 2026-10-10 (gpt-6-luna / gpt-6-sol also against Microsoft
 * Foundry). Empty rows are fallbacks for untested family members: they assume
 * only what every reasoning model shares. Matching is best-effort on Foundry,
 * where `model` is a deployment name.
 */
const REASONING_PROFILES: ReadonlyArray<readonly [prefix: string, profile: ReasoningProfile]> = [
  ['o3-mini', { minEffort: 'low', stop: true }],
  ['o1', { minEffort: 'low', stop: true }],
  ['o3', { minEffort: 'low' }],
  ['o4', { minEffort: 'low' }],
  ['gpt-5.1', { minEffort: 'none', maxEffort: 'high', defaultNone: true }],
  ['gpt-5.2', { minEffort: 'none', defaultNone: true }],
  ['gpt-5.4', { minEffort: 'none', defaultNone: true, tools: 'no-reasoning' }],
  ['gpt-5.5', { minEffort: 'none', tools: 'no-reasoning' }],
  ['gpt-5.6', { minEffort: 'none', tools: 'no-reasoning' }],
  ['gpt-5.', {}],
  ['gpt-5', { minEffort: 'minimal', maxEffort: 'high' }],
  ['gpt-6-luna', { minEffort: 'none', tools: 'no-reasoning' }],
  ['gpt-6-sol', { minEffort: 'none', tools: 'no-reasoning' }],
  ['gpt-6-astra', { minEffort: 'low', tools: 'never' }],
  ['gpt-6.1', { minEffort: 'low', tools: 'never' }],
  ['gpt-6', {}],
];

function reasoningProfile(model: string): ReasoningProfile | undefined {
  const id = model.toLowerCase();
  return REASONING_PROFILES.find(([prefix]) => id.startsWith(prefix))?.[1];
}

/** True for o-series, gpt-5 and gpt-6 models — all of which reject `max_tokens` and `logit_bias`. */
export function isReasoningModel(model: string): boolean {
  return reasoningProfile(model) !== undefined;
}

function hasTools(req: CanonicalChatRequest): boolean {
  return Array.isArray(req.tools) && req.tools.length > 0;
}

/** The `reasoning_effort` to send once the model's rules are applied; `undefined` leaves the field out. */
function resolveReasoningEffort(req: CanonicalChatRequest, profile: ReasoningProfile): string | undefined {
  const requested: string | undefined = req.reasoning_effort;
  if (profile.tools === 'no-reasoning' && hasTools(req)) {
    return requested === undefined && profile.defaultNone ? undefined : 'none';
  }
  if (profile.minEffort) {
    if ((requested === 'none' || requested === 'minimal') && requested !== profile.minEffort) return profile.minEffort;
    if (requested === 'xhigh' && profile.maxEffort) return profile.maxEffort;
  }
  return requested;
}

/**
 * Sampling, penalty and logprob controls (`temperature`, `top_p`,
 * `presence_penalty`, `frequency_penalty`, `logprobs`, `top_logprobs`):
 * reasoning models accept them only on requests that run without reasoning —
 * effort 'none', explicit or by default. Dropped with a warning otherwise.
 */
export function droppedWhileReasoning(field: keyof CanonicalChatRequest): MapAction {
  return {
    kind: 'custom',
    apply(body, value, ctx) {
      const { model } = ctx.fullRequest;
      const profile = reasoningProfile(model);
      if (profile) {
        const effort = resolveReasoningEffort(ctx.fullRequest, profile);
        const reasons = !(effort === 'none' || (effort === undefined && profile.defaultNone));
        if (reasons) {
          const hint = profile.minEffort === 'none' ? ` unless reasoning_effort is 'none'` : '';
          ctx.warn(`'${field}' unsupported on reasoning model ${model}${hint} -- dropped`);
          return;
        }
      }
      body[field] = value;
    },
  };
}

/**
 * `logit_bias` (rejected by every reasoning model) and `stop` (rejected by
 * all but o1 and o3-mini), whatever the effort. Dropped with a warning.
 */
export function droppedOnReasoningModels(
  field: 'stop' | 'logit_bias',
  transform: (value: unknown) => unknown = (value) => value,
): MapAction {
  return {
    kind: 'custom',
    apply(body, value, ctx) {
      const { model } = ctx.fullRequest;
      const profile = reasoningProfile(model);
      if (profile && !(field === 'stop' && profile.stop)) {
        ctx.warn(`'${field}' unsupported on reasoning model ${model} -- dropped`);
        return;
      }
      body[field] = transform(value);
    },
  };
}

/**
 * `reasoning_effort`, adjusted to what the model accepts:
 *  - a level the model lacks is sent as its nearest one: 'minimal' → 'none'
 *    on gpt-5.1+, 'none' → 'minimal' on gpt-5, either → 'low' on o-series,
 *    gpt-6-astra and gpt-6.1; 'xhigh' → 'high' on gpt-5 and gpt-5.1;
 *  - from gpt-5.4 on, Chat Completions only takes function tools alongside
 *    effort 'none', and gpt-5.5+ reason by default, so 'none' is sent
 *    explicitly whenever tools are present;
 *  - gpt-6-astra and gpt-6.1 take no function tools on Chat Completions at
 *    all (Responses API only): the request is left alone and a warning says
 *    the upstream will reject it.
 */
export const modelAwareReasoningEffort: MapAction = {
  kind: 'always',
  apply(body, value, ctx) {
    const req = ctx.fullRequest;
    const profile = reasoningProfile(req.model);
    if (!profile) {
      if (value !== undefined) body.reasoning_effort = value;
      return;
    }

    const toolsNeedNoReasoning = profile.tools === 'no-reasoning' && hasTools(req);
    if (profile.tools === 'never' && hasTools(req)) {
      ctx.warn(`function tools are not supported for ${req.model} on chat completions (Responses API only) -- the upstream will reject this request`);
    }

    const effort = resolveReasoningEffort(req, profile);
    if (effort !== value) {
      ctx.warn(
        toolsNeedNoReasoning
          ? `reasoning_effort forced to 'none' for ${req.model} -- function tools on chat completions require it`
          : `reasoning_effort '${String(value)}' unsupported on ${req.model} -- sent as '${effort}'`,
      );
    }
    if (effort !== undefined) body.reasoning_effort = effort;
  },
};

export const openaiChatConfig: ProviderParamConfig = {
  temperature: droppedWhileReasoning('temperature'),
  top_p: droppedWhileReasoning('top_p'),
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
  stop: droppedOnReasoningModels('stop'),
  frequency_penalty: droppedWhileReasoning('frequency_penalty'),
  presence_penalty: droppedWhileReasoning('presence_penalty'),
  logit_bias: droppedOnReasoningModels('logit_bias'),
  seed: { kind: 'passthrough' },
  user: { kind: 'passthrough' },
  logprobs: droppedWhileReasoning('logprobs'),
  top_logprobs: droppedWhileReasoning('top_logprobs'),
  response_format: { kind: 'passthrough' },
  tools: { kind: 'passthrough' },
  tool_choice: { kind: 'passthrough' },
  parallel_tool_calls: { kind: 'passthrough' },
  reasoning_effort: modelAwareReasoningEffort,
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
    throw new UpstreamError(message, res.status, errorBody, parseRetryAfterMs(res.headers));
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
