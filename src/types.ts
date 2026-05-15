/**
 * Canonical Chat-Completion request and response shapes.
 *
 * The library uses the OpenAI Chat Completions shape as its canonical
 * format. All provider configs map FROM this shape TO their native
 * shape. Provider adapters reverse the translation for responses, so
 * callers always work in OpenAI shape regardless of the upstream.
 */

export type ProviderName =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'perplexity'
  | 'xai'
  | 'kimi';

export type Role = 'system' | 'user' | 'assistant' | 'tool' | 'developer';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
  /**
   * DeepSeek v4 thinking-mode: assistant messages may carry reasoning_content,
   * which MUST be sent back unchanged on subsequent turns. All other providers
   * reject the field on assistant messages, so it is stripped automatically.
   */
  reasoning_content?: string;
}

export interface ChatToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ChatTool {
  type: 'function';
  function: ChatToolFunction;
}

export type ChatToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface ResponseFormatJsonSchema {
  type: 'json_schema';
  json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean };
}

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | ResponseFormatJsonSchema;

export interface CanonicalChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  n?: number;
  max_completion_tokens?: number;
  /** @deprecated alias of max_completion_tokens — accepted for back-compat */
  max_tokens?: number;
  stop?: string | string[];
  frequency_penalty?: number;
  presence_penalty?: number;
  logit_bias?: Record<string, number>;
  seed?: number;
  user?: string;
  logprobs?: boolean;
  top_logprobs?: number;
  response_format?: ResponseFormat;
  tools?: ChatTool[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  /**
   * Provider-specific escape hatch. The entry whose key matches the active
   * provider is shallow-merged into the upstream body verbatim. Use sparingly
   * for fields the canonical shape does not cover.
   */
  provider_options?: Partial<Record<ProviderName, Record<string, unknown>>>;
}

export interface CanonicalChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: ChatToolCall[];
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string;
  }>;
  usage: TokenUsage;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}
