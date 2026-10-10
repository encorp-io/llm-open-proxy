/**
 * Anthropic provider — translates OpenAI Chat Completions ↔ Anthropic
 * Messages API in both directions, including SSE streaming.
 *
 * This is the heaviest adapter because Anthropic's shape diverges in three
 * places: system messages live on a top-level `system` field, tool calls
 * use `tool_use` / `tool_result` content blocks, and response_format becomes
 * `output_config`. Everything else flows through the declarative engine.
 *
 * Current Claude families (Opus 4.7+, the 5.x line) reject sampling controls
 * and budget thinking; a per-family table drops the former and maps
 * `reasoning_effort` to adaptive thinking plus `output_config.effort` there.
 */

import type {
  CanonicalChatRequest,
  CanonicalChatResponse,
  ChatMessage,
  ChatToolCall,
  ContentPart,
  TokenUsage,
} from '../types.js';
import type { MapAction, ProviderParamConfig, TransformCtx } from '../engine.js';
import { transformChatRequest } from '../engine.js';
import {
  resolveMaxCompletionTokens,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_EFFORT,
  ANTHROPIC_THINKING_BUDGET,
  clampTemperature,
  stripReasoningContent,
} from '../helpers.js';
import { UpstreamError, upstreamErrorMessage } from '../errors.js';
import { parseRetryAfterMs } from '../retry.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 600_000;
/** Header names that carry a credential; any of these in `opts.headers` replaces the default x-api-key. */
const AUTH_HEADER_NAMES = new Set(['authorization', 'api-key', 'x-api-key']);

// ---------------------------------------------------------------------------
// Model-family rules (shared with Claude on Microsoft Foundry)
// ---------------------------------------------------------------------------

interface AdaptiveThinkingProfile {
  /**
   * How `reasoning_effort: 'none'` is honoured. 'omit': thinking is off unless
   * requested, so nothing is sent. 'disable': thinking is on by default, so
   * `{type: 'disabled'}` is sent. 'low': thinking cannot be turned off, so the
   * lowest effort is sent instead.
   */
  none: 'omit' | 'disable' | 'low';
}

/**
 * Claude families that reject `temperature`, `top_p`, `top_k` and budget
 * thinking (`{type: 'enabled', budget_tokens}`), keyed by family and version.
 * They take adaptive thinking plus `output_config.effort` (low to max)
 * instead. The sampling and thinking rejections, and acceptance of adaptive
 * thinking, were verified live against Anthropic's API on 2026-10-10 for
 * every row except opus-4-8, fable-* and mythos-*, whose rows follow
 * Anthropic's model documentation. The `none` handling follows the
 * documentation everywhere.
 *
 * Families not listed (haiku-4-5, sonnet-4-5, opus-4-6, sonnet-4-6, older
 * models, and anything unknown) keep sampling controls and budget thinking.
 */
const ADAPTIVE_THINKING_PROFILES: ReadonlyMap<string, AdaptiveThinkingProfile> = new Map([
  ['opus-4-7', { none: 'omit' }],
  ['opus-4-8', { none: 'omit' }],
  ['opus-5', { none: 'disable' }],
  ['opus-5-5', { none: 'low' }],
  ['sonnet-5', { none: 'disable' }],
  ['sonnet-5-5', { none: 'low' }],
  ['haiku-5-5', { none: 'disable' }],
  ['fable-5', { none: 'low' }],
  ['fable-5-1', { none: 'low' }],
  ['mythos-5', { none: 'low' }],
  ['mythos-5-1', { none: 'low' }],
]);

/**
 * `claude-<family>-<major>[-<minor>]` anywhere in the id, so date suffixes
 * (`claude-haiku-4-5-20251001`) and Foundry deployment names that embed the
 * model id (`prod-claude-opus-4-7`) resolve. A minor version is one or two
 * digits; eight digits are a date.
 */
const CLAUDE_FAMILY_PATTERN = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d{1,2})(?!\d))?/;

/**
 * The adaptive-thinking profile for `model`, if its family has one.
 * Best-effort on Foundry, where `model` is a deployment name.
 */
function adaptiveThinkingProfile(model: string): AdaptiveThinkingProfile | undefined {
  const match = CLAUDE_FAMILY_PATTERN.exec(model.toLowerCase());
  if (!match) return undefined;
  const [, family, major, minor] = match;
  return ADAPTIVE_THINKING_PROFILES.get(minor ? `${family}-${major}-${minor}` : `${family}-${major}`);
}

type CanonicalEffort = Exclude<NonNullable<CanonicalChatRequest['reasoning_effort']>, 'none'>;

/** budget_tokens must be at least this, and below max_tokens. */
const MIN_THINKING_BUDGET = 1024;

/**
 * The thinking budget the requested `reasoning_effort` stands for, whatever
 * the model; `undefined` when no thinking is requested.
 */
function nominalThinkingBudget(req: CanonicalChatRequest): number | undefined {
  const effort = req.reasoning_effort;
  if (effort === undefined || effort === 'none') return undefined;
  return ANTHROPIC_THINKING_BUDGET[effort as CanonicalEffort] ?? ANTHROPIC_THINKING_BUDGET.medium;
}

/**
 * The `budget_tokens` to send when `req.model` uses budget thinking: the
 * nominal budget, clamped below an explicit max_tokens (thinking counts
 * toward it, as reasoning counts toward OpenAI's max_completion_tokens).
 * `undefined` when thinking stays off — not requested, or the max_tokens cap
 * has no room for the minimum budget.
 */
function thinkingBudget(req: CanonicalChatRequest): number | undefined {
  const nominal = nominalThinkingBudget(req);
  if (nominal === undefined) return undefined;
  const maxTokens = resolveMaxCompletionTokens(req);
  if (maxTokens === undefined || nominal < maxTokens) return nominal;
  return maxTokens - 1 >= MIN_THINKING_BUDGET ? maxTokens - 1 : undefined;
}

/**
 * `temperature`, `top_p` and `top_k`. Adaptive-thinking families reject all
 * three. Budget thinking on older models takes only `temperature` 1 and
 * `top_p` ≥ 0.95, and no `top_k`. Anything else is dropped with a warning;
 * `keep` forwards accepted values.
 */
function samplingControl(
  field: 'temperature' | 'top_p' | 'top_k',
  keep: (body: Record<string, unknown>, value: unknown, ctx: TransformCtx) => void,
): MapAction {
  return {
    kind: 'custom',
    apply(body, value, ctx) {
      const req = ctx.fullRequest;
      if (adaptiveThinkingProfile(req.model)) {
        ctx.warn(`'${field}' unsupported on ${req.model} -- dropped`);
        return;
      }
      if (thinkingBudget(req) !== undefined) {
        const accepted =
          (field === 'temperature' && value === 1) || (field === 'top_p' && Number(value) >= 0.95);
        if (!accepted) {
          ctx.warn(`'${field}' ${String(value)} unsupported while thinking is enabled -- dropped`);
          return;
        }
      }
      keep(body, value, ctx);
    },
  };
}

/**
 * `reasoning_effort` on an adaptive-thinking family: adaptive thinking plus
 * `output_config.effort` ('minimal' sent as 'low'), and 'none' per the
 * family's profile. `toAnthropicRequest` merges `output_config.format` in.
 */
function applyAdaptiveEffort(
  body: Record<string, unknown>,
  value: unknown,
  profile: AdaptiveThinkingProfile,
  ctx: TransformCtx,
): void {
  const { model } = ctx.fullRequest;
  if (value === 'none') {
    if (profile.none === 'disable') {
      body.thinking = { type: 'disabled' };
    } else if (profile.none === 'low') {
      ctx.warn(`thinking cannot be turned off on ${model} -- reasoning_effort 'none' sent as effort 'low'`);
      body.output_config = { effort: 'low' };
    }
    return;
  }
  const effort = ANTHROPIC_EFFORT[value as CanonicalEffort] ?? 'medium';
  if (effort !== value) {
    ctx.warn(`reasoning_effort '${String(value)}' unsupported on ${model} -- sent as effort '${effort}'`);
  }
  body.thinking = { type: 'adaptive' };
  body.output_config = { effort };
}

// ---------------------------------------------------------------------------
// Provider config — declarative scalar-field mapping
// ---------------------------------------------------------------------------

export const anthropicChatConfig: ProviderParamConfig = {
  temperature: samplingControl('temperature', (body, value, ctx) => {
    body.temperature = clampTemperature(Number(value), 1.0, ctx.warn);
  }),
  top_p: samplingControl('top_p', (body, value) => {
    body.top_p = value;
  }),
  top_k: samplingControl('top_k', (body, value) => {
    body.top_k = value;
  }),
  n: { kind: 'drop', reason: 'Anthropic only supports n=1' },
  max_completion_tokens: { kind: 'rename', to: 'max_tokens' },
  max_tokens: {
    kind: 'always',
    apply(body, _value, ctx) {
      const resolved = resolveMaxCompletionTokens(ctx.fullRequest);
      if (resolved !== undefined) {
        body.max_tokens = resolved;
        return;
      }
      // Thinking counts toward max_tokens, so leave the requested effort's
      // budget on top of the default answer room.
      const budget = nominalThinkingBudget(ctx.fullRequest);
      body.max_tokens = ANTHROPIC_DEFAULT_MAX_TOKENS + (budget ?? 0);
      ctx.warn(
        budget === undefined
          ? `max_tokens missing -- defaulted to ${ANTHROPIC_DEFAULT_MAX_TOKENS} (Anthropic requires it)`
          : `max_tokens missing -- defaulted to ${body.max_tokens} (Anthropic requires it; ${ANTHROPIC_DEFAULT_MAX_TOKENS} plus ${budget} for reasoning_effort '${String(ctx.fullRequest.reasoning_effort)}')`,
      );
    },
  },
  stop: { kind: 'rename', to: 'stop_sequences' },
  frequency_penalty: { kind: 'drop', reason: 'Anthropic does not support frequency_penalty' },
  presence_penalty: { kind: 'drop', reason: 'Anthropic does not support presence_penalty' },
  logit_bias: { kind: 'drop', reason: 'Anthropic does not support logit_bias' },
  seed: { kind: 'drop', reason: 'Anthropic does not support seed' },
  user: {
    kind: 'custom',
    apply(body, value) {
      const md = (body.metadata as Record<string, unknown> | undefined) ?? {};
      md.user_id = value;
      body.metadata = md;
    },
  },
  logprobs: { kind: 'drop', reason: 'Anthropic does not support logprobs' },
  top_logprobs: { kind: 'drop', reason: 'Anthropic does not support top_logprobs' },
  response_format: { kind: 'drop', reason: 'handled by adapter (JSON via output_config)' },
  tools: { kind: 'drop', reason: 'handled by adapter (tools need input_schema reshape)' },
  tool_choice: { kind: 'drop', reason: 'handled by adapter ({type, name} reshape)' },
  parallel_tool_calls: { kind: 'drop', reason: 'Anthropic uses disable_parallel_tool_use on tool_choice' },
  reasoning_effort: {
    kind: 'custom',
    apply(body, value, ctx) {
      const req = ctx.fullRequest;
      const profile = adaptiveThinkingProfile(req.model);
      if (profile) {
        applyAdaptiveEffort(body, value, profile, ctx);
        return;
      }
      // 'none' means no thinking — which is the default on these models.
      if (value === 'none') return;
      const budget = thinkingBudget(req);
      const nominal = nominalThinkingBudget(req);
      if (budget === undefined) {
        ctx.warn(
          `max_tokens ${resolveMaxCompletionTokens(req)} leaves no room for thinking (budget_tokens must be at least ${MIN_THINKING_BUDGET} and below max_tokens) -- reasoning_effort '${String(value)}' ignored`,
        );
        return;
      }
      if (budget !== nominal) {
        ctx.warn(`thinking budget ${nominal} clamped to ${budget} to fit under max_tokens ${resolveMaxCompletionTokens(req)}`);
      }
      body.thinking = { type: 'enabled', budget_tokens: budget };
    },
  },
  stream: { kind: 'passthrough' },
  stream_options: { kind: 'drop', reason: 'Anthropic surfaces usage in message_delta automatically' },
};

// ---------------------------------------------------------------------------
// Anthropic native shape
// ---------------------------------------------------------------------------

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'image'; source: { type: 'url'; url: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface AnthropicRequest {
  model: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }>;
  system?: string;
  max_tokens: number;
  temperature?: number;
  stream?: boolean;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_choice?: { type: 'auto' | 'any' | 'none' | 'tool'; name?: string };
  thinking?:
    | { type: 'enabled'; budget_tokens: number }
    | { type: 'adaptive' }
    | { type: 'disabled' };
  output_config?: {
    format?: {
      type: 'json_schema';
      schema: Record<string, unknown>;
    };
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  };
  [key: string]: unknown;
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  model: string;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

// ---------------------------------------------------------------------------
// Request translation: canonical (OpenAI) → Anthropic
// ---------------------------------------------------------------------------

export interface RequestTranslationResult {
  request: AnthropicRequest;
  warnings: string[];
}

export function toAnthropicRequest(canonical: CanonicalChatRequest): RequestTranslationResult {
  // Anthropic rejects unknown fields on assistant messages — strip the
  // DeepSeek-specific reasoning_content if it leaked in.
  const inboundMessages = stripReasoningContent(canonical.messages);
  const sourceBody: CanonicalChatRequest = { ...canonical, messages: inboundMessages };

  const { body: engineBody, warnings } = transformChatRequest(
    sourceBody,
    anthropicChatConfig,
    'anthropic',
  );

  let systemPrompt: string | undefined;
  const messages: AnthropicRequest['messages'] = [];
  let pendingToolResults: AnthropicContentBlock[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length > 0) {
      messages.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const msg of inboundMessages) {
    if (msg.role === 'system') {
      flushToolResults();
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
                .map((p) => p.text)
                .join('')
            : '';
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
    } else if (msg.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: msg.tool_call_id ?? '',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      });
    } else if (msg.role === 'assistant' && msg.tool_calls) {
      flushToolResults();
      const contentBlocks: AnthropicContentBlock[] = [];
      if (msg.content && typeof msg.content === 'string' && msg.content.length > 0) {
        contentBlocks.push({ type: 'text', text: msg.content });
      }
      for (const tc of msg.tool_calls) {
        contentBlocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {},
        });
      }
      messages.push({ role: 'assistant', content: contentBlocks });
    } else {
      flushToolResults();
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map(contentPartToAnthropicBlock)
            : '';
      messages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content,
      });
    }
  }
  flushToolResults();

  // Layer in message-shape fields the engine intentionally skips.
  const engineRest = { ...engineBody };
  delete engineRest.model;
  delete engineRest.messages;

  const anthropicRequest: AnthropicRequest = {
    ...(engineRest as Partial<AnthropicRequest>),
    model: canonical.model,
    messages,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    // Engine guarantees max_tokens is set via the `always` action on the config.
    max_tokens: engineRest.max_tokens as number,
  } as AnthropicRequest;

  if (canonical.tools) {
    anthropicRequest.tools = canonical.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
  }

  if (canonical.tool_choice) {
    if (canonical.tool_choice === 'auto') {
      anthropicRequest.tool_choice = { type: 'auto' };
    } else if (canonical.tool_choice === 'none') {
      delete anthropicRequest.tools;
    } else if (canonical.tool_choice === 'required') {
      anthropicRequest.tool_choice = { type: 'any' };
    } else if (typeof canonical.tool_choice === 'object' && canonical.tool_choice.function?.name) {
      anthropicRequest.tool_choice = { type: 'tool', name: canonical.tool_choice.function.name };
    }
  }

  // Merged, not assigned: the engine may already have set output_config.effort.
  const responseFormat = canonical.response_format;
  if (responseFormat) {
    if (responseFormat.type === 'json_object') {
      anthropicRequest.output_config = {
        ...anthropicRequest.output_config,
        format: { type: 'json_schema', schema: { type: 'object' } },
      };
    } else if (responseFormat.type === 'json_schema' && responseFormat.json_schema?.schema) {
      anthropicRequest.output_config = {
        ...anthropicRequest.output_config,
        format: { type: 'json_schema', schema: responseFormat.json_schema.schema },
      };
    }
  }

  return { request: anthropicRequest, warnings };
}

function contentPartToAnthropicBlock(part: ContentPart): AnthropicContentBlock {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  const url = part.image_url.url;
  const dataUriMatch = url.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUriMatch) {
    return { type: 'image', source: { type: 'base64', media_type: dataUriMatch[1], data: dataUriMatch[2] } };
  }
  return { type: 'image', source: { type: 'url', url } };
}

// ---------------------------------------------------------------------------
// Response translation: Anthropic → canonical (OpenAI)
// ---------------------------------------------------------------------------

export function toCanonicalResponse(
  anthropicRes: AnthropicResponse,
  model: string,
): CanonicalChatResponse {
  const textContent = anthropicRes.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');

  const toolUseBlocks = anthropicRes.content.filter((b) => b.type === 'tool_use');

  const message: CanonicalChatResponse['choices'][number]['message'] = {
    role: 'assistant',
    content: textContent || null,
  };

  if (toolUseBlocks.length > 0) {
    message.tool_calls = toolUseBlocks.map<ChatToolCall>((b) => ({
      id: b.id ?? '',
      type: 'function' as const,
      function: {
        name: b.name ?? '',
        arguments: JSON.stringify(b.input ?? {}),
      },
    }));
  }

  return {
    id: `chatcmpl-${anthropicRes.id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapStopReason(anthropicRes.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: anthropicRes.usage.input_tokens,
      completion_tokens: anthropicRes.usage.output_tokens,
      total_tokens: anthropicRes.usage.input_tokens + anthropicRes.usage.output_tokens,
    },
  };
}

function mapStopReason(reason: string): string {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

// ---------------------------------------------------------------------------
// Transport — Anthropic Messages API + translation
// ---------------------------------------------------------------------------

export interface AnthropicSendOptions {
  apiKey: string;
  body: CanonicalChatRequest;
  baseUrl?: string;
  apiVersion?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Extra headers merged over the defaults (e.g. `anthropic-beta`). If this
   * carries its own credential (`Authorization`, `api-key` or `x-api-key`,
   * any casing), the default `x-api-key: <apiKey>` header is omitted — this
   * is how Anthropic-compatible hosts that use bearer auth (e.g. Microsoft
   * Foundry with Entra ID) are reached.
   */
  headers?: Record<string, string>;
}

export interface AnthropicSendResult {
  response: CanonicalChatResponse;
  usage: TokenUsage;
  warnings: string[];
}

export interface AnthropicStreamResult {
  stream: ReadableStream<Uint8Array>;
  getUsage: () => TokenUsage;
  warnings: string[];
}

export async function sendAnthropicRequest(opts: AnthropicSendOptions): Promise<AnthropicSendResult> {
  const { request: anthropicBody, warnings } = toAnthropicRequest(opts.body);
  const res = await anthropicFetch(opts, { ...anthropicBody, stream: false });

  const data = (await res.json()) as AnthropicResponse;
  const response = toCanonicalResponse(data, opts.body.model);

  return {
    response,
    usage: {
      prompt_tokens: data.usage.input_tokens,
      completion_tokens: data.usage.output_tokens,
      total_tokens: data.usage.input_tokens + data.usage.output_tokens,
    },
    warnings,
  };
}

export async function streamAnthropicRequest(opts: AnthropicSendOptions): Promise<AnthropicStreamResult> {
  const { request: anthropicBody, warnings } = toAnthropicRequest(opts.body);
  const res = await anthropicFetch(opts, { ...anthropicBody, stream: true });

  if (!res.body) {
    throw new UpstreamError('No response body from Anthropic', 502);
  }

  const usage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const completionId = `chatcmpl-${Date.now()}`;
  const model = opts.body.model;
  let buffer = '';

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = res.body!.getReader();
      let toolCallIndex = -1;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          // String.split always returns at least one element, so pop() never
          // returns undefined here.
          buffer = lines.pop()!;

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (!payload || payload === '[DONE]') continue;

            let event: AnthropicStreamEvent;
            try {
              event = JSON.parse(payload) as AnthropicStreamEvent;
            } catch {
              continue;
            }

            if (event.type === 'message_start' && event.message?.usage) {
              usage.prompt_tokens = event.message.usage.input_tokens ?? 0;
            } else if (
              event.type === 'content_block_start' &&
              event.content_block?.type === 'tool_use'
            ) {
              toolCallIndex++;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index: toolCallIndex,
                              id: event.content_block.id,
                              type: 'function',
                              function: { name: event.content_block.name, arguments: '' },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  })}\n\n`,
                ),
              );
            } else if (
              event.type === 'content_block_delta' &&
              event.delta?.type === 'input_json_delta'
            ) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index: toolCallIndex,
                              function: { arguments: event.delta.partial_json ?? '' },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  })}\n\n`,
                ),
              );
            } else if (event.type === 'content_block_delta' && event.delta?.text) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [
                      { index: 0, delta: { content: event.delta.text }, finish_reason: null },
                    ],
                  })}\n\n`,
                ),
              );
            } else if (event.type === 'message_delta') {
              if (event.usage) {
                usage.completion_tokens = event.usage.output_tokens ?? 0;
                usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
              }
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: {},
                        finish_reason: mapStopReason(event.delta?.stop_reason ?? 'end_turn'),
                      },
                    ],
                  })}\n\n`,
                ),
              );
            }
          }
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return { stream, getUsage: () => usage, warnings };
}

interface AnthropicStreamEvent {
  type: string;
  message?: { usage?: { input_tokens?: number } };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: { output_tokens?: number };
}

async function anthropicFetch(
  opts: AnthropicSendOptions,
  body: Record<string, unknown>,
): Promise<Response> {
  const url = opts.baseUrl ?? ANTHROPIC_API_URL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

  const extraHeaders = opts.headers ?? {};
  const hasOwnCredential = Object.keys(extraHeaders).some((h) =>
    AUTH_HEADER_NAMES.has(h.toLowerCase()),
  );

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(hasOwnCredential ? {} : { 'x-api-key': opts.apiKey }),
        'anthropic-version': opts.apiVersion ?? ANTHROPIC_VERSION,
        ...extraHeaders,
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
    const message = upstreamErrorMessage(errorBody) ?? `Anthropic API error ${res.status}`;
    throw new UpstreamError(message, res.status, errorBody, parseRetryAfterMs(res.headers));
  }

  return res;
}

// Marker for unused message-helper imports.
export type { ChatMessage };
