/**
 * Anthropic provider — translates OpenAI Chat Completions ↔ Anthropic
 * Messages API in both directions, including SSE streaming.
 *
 * This is the heaviest adapter because Anthropic's shape diverges in three
 * places: system messages live on a top-level `system` field, tool calls
 * use `tool_use` / `tool_result` content blocks, and response_format becomes
 * `output_config`. Everything else flows through the declarative engine.
 */

import type {
  CanonicalChatRequest,
  CanonicalChatResponse,
  ChatMessage,
  ChatToolCall,
  ContentPart,
  TokenUsage,
} from '../types.js';
import type { ProviderParamConfig } from '../engine.js';
import { transformChatRequest } from '../engine.js';
import {
  resolveMaxCompletionTokens,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_THINKING_BUDGET,
  clampTemperature,
  stripReasoningContent,
} from '../helpers.js';
import { UpstreamError } from '../errors.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Provider config — declarative scalar-field mapping
// ---------------------------------------------------------------------------

export const anthropicChatConfig: ProviderParamConfig = {
  temperature: {
    kind: 'custom',
    apply(body, value, ctx) {
      body.temperature = clampTemperature(Number(value), 1.0, ctx.warn);
    },
  },
  top_p: { kind: 'passthrough' },
  top_k: { kind: 'passthrough' },
  n: { kind: 'drop', reason: 'Anthropic only supports n=1' },
  max_completion_tokens: { kind: 'rename', to: 'max_tokens' },
  max_tokens: {
    kind: 'always',
    apply(body, _value, ctx) {
      const resolved = resolveMaxCompletionTokens(ctx.fullRequest);
      body.max_tokens = resolved ?? ANTHROPIC_DEFAULT_MAX_TOKENS;
      if (resolved === undefined) {
        ctx.warn(`max_tokens missing -- defaulted to ${ANTHROPIC_DEFAULT_MAX_TOKENS} (Anthropic requires it)`);
      }
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
    apply(body, value) {
      const effort = value as keyof typeof ANTHROPIC_THINKING_BUDGET;
      const budget = ANTHROPIC_THINKING_BUDGET[effort] ?? ANTHROPIC_THINKING_BUDGET.medium;
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
  output_config?: {
    format: {
      type: 'json_schema';
      schema: Record<string, unknown>;
    };
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

  const responseFormat = canonical.response_format;
  if (responseFormat) {
    if (responseFormat.type === 'json_object') {
      anthropicRequest.output_config = {
        format: { type: 'json_schema', schema: { type: 'object' } },
      };
    } else if (responseFormat.type === 'json_schema' && responseFormat.json_schema?.schema) {
      anthropicRequest.output_config = {
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

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': opts.apiVersion ?? ANTHROPIC_VERSION,
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
      (errorBody as { error?: { message?: string } })?.error?.message ??
      `Anthropic API error ${res.status}`;
    throw new UpstreamError(message, res.status, errorBody);
  }

  return res;
}

// Marker for unused message-helper imports.
export type { ChatMessage };
