/**
 * Microsoft Foundry provider (formerly Azure AI Foundry).
 *
 * One Foundry resource speaks several wire protocols; `api` picks which:
 *
 *  - `openai-v1` (default, recommended) — `{endpoint}/openai/v1/chat/completions`.
 *    OpenAI-compatible, no `api-version`, `model` is the deployment name.
 *    Serves Azure OpenAI deployments *and* the non-OpenAI Foundry Models
 *    (DeepSeek, Grok, Llama, Mistral, MAI, …).
 *  - `openai-deployments` — the dated Azure OpenAI API:
 *    `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…`.
 *  - `model-inference` — the deprecated Azure AI Model Inference API:
 *    `{endpoint}/models/chat/completions?api-version=…`. Legacy only.
 *  - `anthropic` — Claude on Foundry: `{endpoint}/anthropic/v1/messages`.
 *    Reuses the Anthropic translator; only the URL and auth differ.
 *
 * Auth is either an API key (`api-key` header; `x-api-key` for Claude) or a
 * Microsoft Entra ID token provider (`Authorization: Bearer`).
 *
 * Azure-specific response quirks on the OpenAI surfaces are normalized back
 * to canonical shape:
 *  - streaming: the choice-less prompt-annotation chunk is dropped (its
 *    verdicts stay available via `getPromptFilterResults()`), blank
 *    id/model/created on async-filter annotation chunks are backfilled, and
 *    delta-less choices get `delta: {}` so OpenAI clients don't trip on them;
 *  - reasoning models that inline a leading `<think>…</think>` block
 *    (DeepSeek-R1 & co.) have it moved into `reasoning_content`;
 *  - every Azure error envelope — including gateway-level ones on the Claude
 *    route — yields a readable `UpstreamError.message`, and
 *    `getFoundryContentFilterError()` reads content-safety rejections.
 *
 * Wire reference: https://learn.microsoft.com/azure/foundry/openai/api-version-lifecycle
 */

import type {
  CanonicalChatRequest,
  CanonicalChatResponse,
  TokenUsage,
} from '../types.js';
import type { MapAction, ProviderParamConfig, TransformResult } from '../engine.js';
import { transformChatRequest } from '../engine.js';
import { modelMatches, resolveMaxCompletionTokens, stripReasoningContent } from '../helpers.js';
import { UpstreamError, upstreamErrorMessage } from '../errors.js';
import { parseRetryAfterMs } from '../retry.js';
import { SAMPLING_LOCKED_PREFIXES } from './openai.js';
import { toAnthropicRequest, sendAnthropicRequest, streamAnthropicRequest } from './anthropic.js';

/** Default `api-version` for `api: 'openai-deployments'` (latest GA). */
export const FOUNDRY_DEPLOYMENTS_API_VERSION = '2024-10-21';
/** Default `api-version` for `api: 'model-inference'` (the only version in the spec). */
export const FOUNDRY_MODEL_INFERENCE_API_VERSION = '2024-05-01-preview';
/** Entra ID scope Foundry documents for the v1 and Claude endpoints. */
export const FOUNDRY_ENTRA_SCOPE = 'https://ai.azure.com/.default';
/** Entra ID scope used by the dated Azure OpenAI and Model Inference APIs. */
export const AZURE_COGNITIVE_SERVICES_SCOPE = 'https://cognitiveservices.azure.com/.default';

const DEFAULT_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Provider configs — declarative scalar-field mapping
// ---------------------------------------------------------------------------

/**
 * Azure OpenAI reasoning models (o-series, gpt-5, gpt-6) reject sampling,
 * penalty, logprob and `stop` controls. Foundry `model` is a deployment name,
 * so detection is best-effort: it works when deployments are named after
 * their model.
 */
function isReasoningModel(model: string): boolean {
  return modelMatches(model, SAMPLING_LOCKED_PREFIXES);
}

function droppedOnReasoningModels(
  field: keyof CanonicalChatRequest,
  transform: (value: unknown) => unknown = (value) => value,
): MapAction {
  return {
    kind: 'custom',
    apply(body, value, ctx) {
      if (isReasoningModel(ctx.fullRequest.model)) {
        ctx.warn(`'${field}' unsupported on reasoning model ${ctx.fullRequest.model} -- dropped`);
        return;
      }
      body[field] = transform(value);
    },
  };
}

/**
 * GPT-6 on Chat Completions only accepts function tools alongside
 * `reasoning_effort: 'none'` — omitting it still fails, since the model
 * reasons by default — and it has no `minimal` level (its lowest is `none`).
 * Verified against Foundry for gpt-6-luna and gpt-6-sol.
 */
const TOOLS_NEED_NO_REASONING_PREFIXES = ['gpt-6'] as const;

const foundryReasoningEffort: MapAction = {
  kind: 'always',
  apply(body, value, ctx) {
    const { model, tools } = ctx.fullRequest;
    if (modelMatches(model, TOOLS_NEED_NO_REASONING_PREFIXES)) {
      if (tools && tools.length > 0) {
        ctx.warn(`reasoning_effort forced to 'none' for ${model} -- function tools on chat completions require it`);
        body.reasoning_effort = 'none';
        return;
      }
      if (value === 'minimal') {
        ctx.warn(`reasoning_effort 'minimal' unsupported on ${model} -- sent as 'none'`);
        body.reasoning_effort = 'none';
        return;
      }
    }
    if (value !== undefined) body.reasoning_effort = value;
  },
};

/**
 * The Model Inference API expects `max_tokens`, but it forwards OpenAI
 * models to Azure OpenAI, whose reasoning deployments reject `max_tokens`
 * and require `max_completion_tokens`.
 */
const modelInferenceMaxTokens: MapAction = {
  kind: 'custom',
  apply(body, _value, ctx) {
    const resolved = resolveMaxCompletionTokens(ctx.fullRequest);
    const field = isReasoningModel(ctx.fullRequest.model) ? 'max_completion_tokens' : 'max_tokens';
    if (resolved !== undefined) body[field] = resolved;
  },
};

/** Config for the OpenAI-compatible surfaces (`openai-v1`, `openai-deployments`). */
export const foundryChatConfig: ProviderParamConfig = {
  temperature: droppedOnReasoningModels('temperature'),
  top_p: droppedOnReasoningModels('top_p'),
  top_k: { kind: 'drop', reason: 'Foundry chat completions do not support top_k' },
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
  frequency_penalty: droppedOnReasoningModels('frequency_penalty'),
  presence_penalty: droppedOnReasoningModels('presence_penalty'),
  logit_bias: droppedOnReasoningModels('logit_bias'),
  seed: { kind: 'passthrough' },
  user: { kind: 'passthrough' },
  logprobs: droppedOnReasoningModels('logprobs'),
  top_logprobs: droppedOnReasoningModels('top_logprobs'),
  response_format: { kind: 'passthrough' },
  tools: { kind: 'passthrough' },
  tool_choice: { kind: 'passthrough' },
  parallel_tool_calls: { kind: 'passthrough' },
  reasoning_effort: foundryReasoningEffort,
  stream: { kind: 'passthrough' },
  stream_options: { kind: 'passthrough' },
};

/**
 * Config for the deprecated Azure AI Model Inference API (`model-inference`).
 * Its published schema is narrower than OpenAI's and unknown fields are
 * rejected unless the `extra-parameters` header says otherwise, so fields
 * outside it drop. `reasoning_effort` and `stream_options` are outside the
 * schema too but verified to be forwarded, so they pass.
 */
export const foundryModelInferenceChatConfig: ProviderParamConfig = {
  temperature: droppedOnReasoningModels('temperature'),
  top_p: droppedOnReasoningModels('top_p'),
  top_k: { kind: 'drop', reason: 'not in the Model Inference schema (send via provider_options with extraParameters)' },
  n: { kind: 'drop', reason: 'the Model Inference API only supports n=1' },
  max_completion_tokens: modelInferenceMaxTokens,
  max_tokens: modelInferenceMaxTokens,
  stop: droppedOnReasoningModels('stop', (v) => (Array.isArray(v) ? v : [v])),
  frequency_penalty: droppedOnReasoningModels('frequency_penalty'),
  presence_penalty: droppedOnReasoningModels('presence_penalty'),
  logit_bias: { kind: 'drop', reason: 'not in the Model Inference schema' },
  seed: { kind: 'passthrough' },
  user: { kind: 'drop', reason: 'not in the Model Inference schema' },
  logprobs: { kind: 'drop', reason: 'not in the Model Inference schema' },
  top_logprobs: { kind: 'drop', reason: 'not in the Model Inference schema' },
  response_format: { kind: 'passthrough' },
  tools: { kind: 'passthrough' },
  tool_choice: { kind: 'passthrough' },
  parallel_tool_calls: { kind: 'drop', reason: 'not in the Model Inference schema' },
  reasoning_effort: foundryReasoningEffort,
  stream: { kind: 'passthrough' },
  stream_options: { kind: 'passthrough' },
};

// ---------------------------------------------------------------------------
// Azure response extensions
// ---------------------------------------------------------------------------

export interface FoundryContentFilterSeverity {
  filtered: boolean;
  severity?: 'safe' | 'low' | 'medium' | 'high';
}

export interface FoundryContentFilterDetection {
  filtered: boolean;
  detected: boolean;
}

/**
 * Azure AI Content Safety verdicts, attached per prompt
 * (`prompt_filter_results`) and per choice (`content_filter_results`).
 * Categories vary by filter configuration, hence the open index signature.
 * `error` means filtering did not run (the request still succeeded).
 */
export interface FoundryContentFilterResults {
  hate?: FoundryContentFilterSeverity;
  sexual?: FoundryContentFilterSeverity;
  violence?: FoundryContentFilterSeverity;
  self_harm?: FoundryContentFilterSeverity;
  jailbreak?: FoundryContentFilterDetection;
  indirect_attack?: FoundryContentFilterDetection;
  protected_material_text?: FoundryContentFilterDetection;
  protected_material_code?: FoundryContentFilterDetection & {
    citation?: { URL?: string; license?: string };
  };
  profanity?: FoundryContentFilterDetection;
  /** An object `{filtered, details}` or, in some responses, an array — both occur. */
  custom_blocklists?: unknown;
  error?: { code: string; message: string };
  [category: string]: unknown;
}

export interface FoundryPromptFilterResult {
  prompt_index: number;
  content_filter_results: FoundryContentFilterResults;
}

export type FoundryTokenUsage = TokenUsage & {
  completion_tokens_details?: {
    reasoning_tokens?: number;
    audio_tokens?: number;
    accepted_prediction_tokens?: number;
    rejected_prediction_tokens?: number;
  };
  prompt_tokens_details?: { cached_tokens?: number; audio_tokens?: number };
};

export type FoundryChatChoice = CanonicalChatResponse['choices'][number] & {
  content_filter_results?: FoundryContentFilterResults;
};

/** Canonical response plus the Azure-only fields Foundry attaches. */
export interface FoundryChatResponse extends Omit<CanonicalChatResponse, 'choices' | 'usage'> {
  choices: FoundryChatChoice[];
  usage: FoundryTokenUsage;
  prompt_filter_results?: FoundryPromptFilterResult[];
  system_fingerprint?: string;
}

// ---------------------------------------------------------------------------
// Target: endpoint + API surface → URL
// ---------------------------------------------------------------------------

export type FoundryApi = 'openai-v1' | 'openai-deployments' | 'model-inference' | 'anthropic';

export interface FoundryTarget {
  /**
   * Resource or project endpoint, e.g. `https://my-res.services.ai.azure.com`,
   * `https://my-res.openai.azure.com` or
   * `https://my-res.services.ai.azure.com/api/projects/my-project`.
   * A trailing API prefix (`/openai/v1`, `/models`, `/anthropic`, …) is tolerated.
   * Only `openai-v1` is served on project endpoints; for the other APIs the
   * `/api/projects/{project}` part is dropped and the resource endpoint used.
   */
  endpoint?: string;
  /**
   * Full request URL, used verbatim instead of building one from `endpoint`.
   * For APIM fronts, legacy serverless (MaaS) or managed-compute endpoints.
   */
  url?: string;
  /** Wire protocol. Default `openai-v1`. */
  api?: FoundryApi;
  /** `openai-deployments` only: deployment id in the path. Defaults to the request `model`. */
  deployment?: string;
  /**
   * `api-version` query value. Required by `openai-deployments` (default
   * {@link FOUNDRY_DEPLOYMENTS_API_VERSION}) and `model-inference` (default
   * {@link FOUNDRY_MODEL_INFERENCE_API_VERSION}); optional on `openai-v1`
   * (`preview` opts into preview features); ignored for `anthropic`.
   */
  apiVersion?: string;
}

const API_PATH_PREFIXES: Record<FoundryApi, string[]> = {
  'openai-v1': ['/openai/v1', '/openai'],
  'openai-deployments': ['/openai'],
  'model-inference': ['/models'],
  anthropic: ['/anthropic/v1', '/anthropic'],
};

function resolveApiVersion(api: FoundryApi, apiVersion: string | undefined): string | undefined {
  if (apiVersion) return apiVersion;
  if (api === 'openai-deployments') return FOUNDRY_DEPLOYMENTS_API_VERSION;
  if (api === 'model-inference') return FOUNDRY_MODEL_INFERENCE_API_VERSION;
  return undefined;
}

/** Build the chat request URL for a Foundry target. Pure — no I/O. */
export function buildFoundryUrl(target: FoundryTarget, model: string): string {
  if (target.url) return target.url;
  if (!target.endpoint) {
    throw new TypeError('Foundry: `endpoint` (or a full `url`) is required');
  }

  const api = target.api ?? 'openai-v1';
  let base = target.endpoint.replace(/\/+$/, '');
  for (const prefix of API_PATH_PREFIXES[api]) {
    if (base.toLowerCase().endsWith(prefix)) {
      base = base.slice(0, -prefix.length);
      break;
    }
  }
  // Project endpoints answer the dated, Model Inference and Claude routes with
  // "API version not supported"; those APIs live on the resource endpoint.
  if (api !== 'openai-v1') base = base.replace(/\/api\/projects\/[^/]+$/i, '');

  const apiVersion = resolveApiVersion(api, target.apiVersion);
  const query = apiVersion ? `?api-version=${encodeURIComponent(apiVersion)}` : '';
  switch (api) {
    case 'openai-v1':
      return `${base}/openai/v1/chat/completions${query}`;
    case 'openai-deployments':
      return `${base}/openai/deployments/${encodeURIComponent(target.deployment ?? model)}/chat/completions${query}`;
    case 'model-inference':
      return `${base}/models/chat/completions${query}`;
    case 'anthropic':
      return `${base}/anthropic/v1/messages`;
  }
}

// ---------------------------------------------------------------------------
// Request translation: canonical (OpenAI) → Foundry surface
// ---------------------------------------------------------------------------

export interface FoundryConvertOptions {
  api?: FoundryApi;
}

/**
 * Canonical request → body for the chosen Foundry surface. Claude
 * (`api: 'anthropic'`) gets the Anthropic Messages shape, so its escape
 * hatch is `provider_options.anthropic`; every other surface reads
 * `provider_options.foundry`.
 */
export function convertFoundryRequest(
  canonical: CanonicalChatRequest,
  opts: FoundryConvertOptions = {},
): TransformResult {
  const api = opts.api ?? 'openai-v1';
  if (api === 'anthropic') {
    const { request, warnings } = toAnthropicRequest(canonical);
    return { body: request as unknown as Record<string, unknown>, warnings };
  }

  const prepared = { ...canonical, messages: stripReasoningContent(canonical.messages) };
  const config = api === 'model-inference' ? foundryModelInferenceChatConfig : foundryChatConfig;
  return transformChatRequest(prepared, config, 'foundry');
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface FoundryAuth {
  /** Resource API key. Sent as `api-key` (`x-api-key` for Claude). */
  apiKey?: string;
  /**
   * Microsoft Entra ID token provider, called once per request. Plug in e.g.
   * `getBearerTokenProvider(new DefaultAzureCredential(), FOUNDRY_ENTRA_SCOPE)`
   * from `@azure/identity`, which caches and refreshes tokens.
   */
  getToken?: () => string | Promise<string>;
}

export interface FoundrySendOptions extends FoundryTarget, FoundryAuth {
  body: CanonicalChatRequest;
  /**
   * `extra-parameters` header (Model Inference API): how the service treats
   * fields outside its schema — `error` (service default), `drop`, or
   * `pass-through` to the model.
   */
  extraParameters?: 'pass-through' | 'drop' | 'error';
  /**
   * Move a leading `<think>…</think>` block out of `content` into
   * `reasoning_content`. Default `true`. Never applied when the upstream
   * already returns `reasoning_content`.
   */
  extractThinkTags?: boolean;
  /** Extra headers merged last (e.g. `x-ms-client-request-id`, `anthropic-beta`). */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Default 10 minutes. */
  timeoutMs?: number;
}

export interface FoundrySendResult {
  response: FoundryChatResponse;
  usage: TokenUsage;
  warnings: string[];
}

export interface FoundryStreamResult {
  /** OpenAI-format SSE. */
  stream: ReadableStream<Uint8Array>;
  getUsage: () => TokenUsage;
  /** Prompt verdicts from the dropped annotation chunk. Always `[]` for Claude. */
  getPromptFilterResults: () => FoundryPromptFilterResult[];
  warnings: string[];
}

export async function sendFoundryRequest(opts: FoundrySendOptions): Promise<FoundrySendResult> {
  const api = opts.api ?? 'openai-v1';
  const url = buildFoundryUrl(opts, opts.body.model);
  const headers = await foundryRequestHeaders(opts, api);

  if (api === 'anthropic') {
    return sendAnthropicRequest({
      apiKey: '',
      body: opts.body,
      baseUrl: url,
      headers,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });
  }

  const { body, warnings } = convertFoundryRequest(opts.body, { api });
  // stream_options is only valid alongside stream: true.
  delete body.stream_options;
  const res = await foundryFetch(url, headers, { ...body, stream: false }, opts);

  const response = (await res.json()) as FoundryChatResponse;
  if (opts.extractThinkTags !== false) extractThinkBlocks(response);
  return { response, usage: toTokenUsage(response.usage), warnings };
}

export async function streamFoundryRequest(opts: FoundrySendOptions): Promise<FoundryStreamResult> {
  const api = opts.api ?? 'openai-v1';
  const url = buildFoundryUrl(opts, opts.body.model);
  const headers = await foundryRequestHeaders(opts, api);

  if (api === 'anthropic') {
    const result = await streamAnthropicRequest({
      apiKey: '',
      body: opts.body,
      baseUrl: url,
      headers,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });
    return { ...result, getPromptFilterResults: () => [] };
  }

  const { body, warnings } = convertFoundryRequest(opts.body, { api });
  // Every OpenAI-compatible API accepts stream_options — including dated GA
  // api-versions and the Model Inference API, whose published schemas omit
  // it — and OpenAI models only report stream usage when asked.
  const upstreamBody: Record<string, unknown> = {
    ...body,
    stream: true,
    stream_options: { ...(body.stream_options as Record<string, unknown> | undefined), include_usage: true },
  };

  const res = await foundryFetch(url, headers, upstreamBody, opts);
  if (!res.body) {
    throw new UpstreamError('No response body from Foundry', 502);
  }

  const normalizer = new FoundryStreamNormalizer(opts.extractThinkTags !== false);
  return {
    stream: res.body.pipeThrough(normalizer.transform()),
    getUsage: () => ({ ...normalizer.usage }),
    getPromptFilterResults: () => [...normalizer.promptFilterResults],
    warnings,
  };
}

async function foundryRequestHeaders(
  opts: FoundrySendOptions,
  api: FoundryApi,
): Promise<Record<string, string>> {
  const apiKey = opts.apiKey || undefined;
  if (apiKey && opts.getToken) {
    throw new TypeError('Foundry: pass either `apiKey` or `getToken`, not both');
  }

  let auth: Record<string, string>;
  if (opts.getToken) {
    auth = { Authorization: `Bearer ${await opts.getToken()}` };
  } else if (apiKey) {
    auth = api === 'anthropic' ? { 'x-api-key': apiKey } : { 'api-key': apiKey };
  } else {
    throw new TypeError('Foundry: an `apiKey` or a `getToken` Entra ID token provider is required');
  }

  return {
    ...auth,
    ...(opts.extraParameters ? { 'extra-parameters': opts.extraParameters } : {}),
    ...(opts.headers ?? {}),
  };
}

async function foundryFetch(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  opts: Pick<FoundrySendOptions, 'signal' | 'timeoutMs'>,
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
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
    const message = upstreamErrorMessage(errorBody) ?? `Foundry error ${res.status}`;
    throw new UpstreamError(message, res.status, errorBody, parseRetryAfterMs(res.headers));
  }

  return res;
}

function toTokenUsage(usage: Partial<TokenUsage> | null | undefined): TokenUsage {
  return {
    prompt_tokens: usage?.prompt_tokens ?? 0,
    completion_tokens: usage?.completion_tokens ?? 0,
    total_tokens: usage?.total_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

interface FoundryInnerError {
  code?: unknown;
  content_filter_result?: FoundryContentFilterResults;
  content_filter_results?: FoundryContentFilterResults;
}

interface FoundryErrorEnvelope {
  code?: unknown;
  innererror?: FoundryInnerError;
  inner_error?: FoundryInnerError;
  error?: FoundryErrorEnvelope;
}

export interface FoundryContentFilterError {
  message: string;
  /** Per-category verdicts, when Azure included them. */
  results?: FoundryContentFilterResults;
}

/**
 * If `err` is a Foundry content-safety rejection (HTTP 400,
 * `code: "content_filter"`), return its message and category verdicts.
 * Reads both the documented (`inner_error.content_filter_results`) and the
 * observed (`innererror.content_filter_result`) spellings.
 */
export function getFoundryContentFilterError(err: unknown): FoundryContentFilterError | undefined {
  if (!(err instanceof UpstreamError)) return undefined;
  const body = err.upstreamBody as FoundryErrorEnvelope | null;
  const error = body?.error ?? body;
  if (!error || typeof error !== 'object') return undefined;

  const inner = error.innererror ?? error.inner_error;
  const results = inner?.content_filter_result ?? inner?.content_filter_results;
  const isFilter =
    error.code === 'content_filter' || inner?.code === 'ResponsibleAIPolicyViolation' || results !== undefined;
  if (!isFilter) return undefined;
  return results ? { message: err.message, results } : { message: err.message };
}

// ---------------------------------------------------------------------------
// <think> extraction
// ---------------------------------------------------------------------------

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

interface SplitText {
  content: string;
  reasoning: string;
}

/**
 * Incrementally moves a *leading* `<think>…</think>` block out of streamed
 * text. Only a block at the very start (after whitespace) counts, so ordinary
 * answers that mention the tag are left alone. Tags may straddle chunk
 * boundaries; ambiguous tails are held back until the next push or flush.
 */
class ThinkTagSplitter {
  private mode: 'detect' | 'think' | 'content' = 'detect';
  private buffer = '';
  private trimReasoning = false;
  private trimContent = false;
  /** True once a leading think block was found. */
  opened = false;

  push(text: string): SplitText {
    this.buffer += text;
    const out: SplitText = { content: '', reasoning: '' };

    while (true) {
      if (this.mode === 'detect') {
        const lead = this.buffer.trimStart();
        if (lead.startsWith(THINK_OPEN)) {
          this.buffer = lead.slice(THINK_OPEN.length);
          this.mode = 'think';
          this.opened = true;
          this.trimReasoning = true;
          continue;
        }
        // Still a possible prefix of "<think>" (or only whitespace so far).
        if (THINK_OPEN.startsWith(lead)) return out;
        this.mode = 'content';
        continue;
      }

      if (this.mode === 'think') {
        const close = this.buffer.indexOf(THINK_CLOSE);
        if (close !== -1) {
          out.reasoning += this.takeReasoning(this.buffer.slice(0, close));
          this.buffer = this.buffer.slice(close + THINK_CLOSE.length);
          this.mode = 'content';
          this.trimContent = true;
          continue;
        }
        const hold = partialSuffixLength(this.buffer, THINK_CLOSE);
        out.reasoning += this.takeReasoning(this.buffer.slice(0, this.buffer.length - hold));
        this.buffer = this.buffer.slice(this.buffer.length - hold);
        return out;
      }

      out.content += this.takeContent(this.buffer);
      this.buffer = '';
      return out;
    }
  }

  /** Release anything held back (end of choice / end of stream). */
  flush(): SplitText {
    const rest = this.buffer;
    this.buffer = '';
    if (this.mode === 'think') return { content: '', reasoning: this.takeReasoning(rest) };
    return { content: this.mode === 'content' ? this.takeContent(rest) : rest, reasoning: '' };
  }

  private takeReasoning(text: string): string {
    if (!this.trimReasoning) return text;
    const trimmed = text.trimStart();
    if (trimmed) this.trimReasoning = false;
    return trimmed;
  }

  private takeContent(text: string): string {
    if (!this.trimContent) return text;
    const trimmed = text.trimStart();
    if (trimmed) this.trimContent = false;
    return trimmed;
  }
}

/** Length of the longest proper prefix of `tag` that `text` ends with. */
function partialSuffixLength(text: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
    if (text.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

function extractThinkBlocks(response: FoundryChatResponse): void {
  for (const choice of response.choices ?? []) {
    const message = choice.message;
    if (typeof message?.content !== 'string' || message.reasoning_content !== undefined) continue;

    const splitter = new ThinkTagSplitter();
    const head = splitter.push(message.content);
    const tail = splitter.flush();
    if (!splitter.opened) continue;
    message.reasoning_content = (head.reasoning + tail.reasoning).trimEnd();
    message.content = head.content + tail.content;
  }
}

// ---------------------------------------------------------------------------
// Streaming normalization
// ---------------------------------------------------------------------------

interface FoundryStreamDelta {
  content?: string | null;
  reasoning_content?: string;
  [key: string]: unknown;
}

interface FoundryStreamChoice {
  index?: number;
  delta?: FoundryStreamDelta;
  finish_reason?: string | null;
  [key: string]: unknown;
}

interface FoundryStreamChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: FoundryStreamChoice[];
  usage?: Partial<TokenUsage> | null;
  prompt_filter_results?: FoundryPromptFilterResult[];
  /** Legacy spelling of `prompt_filter_results` seen in older api-versions. */
  prompt_annotations?: FoundryPromptFilterResult[];
  [key: string]: unknown;
}

class FoundryStreamNormalizer {
  readonly usage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  readonly promptFilterResults: FoundryPromptFilterResult[] = [];
  private readonly splitters = new Map<number, ThinkTagSplitter>();
  private id = '';
  private model = '';
  private created = 0;

  constructor(private readonly extractThinkTags: boolean) {}

  transform(): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';

    type Controller = TransformStreamDefaultController<Uint8Array>;
    const emit = (controller: Controller, payload: string) =>
      controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
    const flushPending = (controller: Controller) => {
      for (const chunk of this.drainSplitters()) emit(controller, JSON.stringify(chunk));
    };

    const handleLine = (line: string, controller: Controller) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      if (payload === '[DONE]') {
        flushPending(controller);
        emit(controller, '[DONE]');
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = undefined;
      }
      if (!parsed || typeof parsed !== 'object') {
        emit(controller, payload);
        return;
      }
      const chunk = this.normalize(parsed as FoundryStreamChunk);
      if (chunk) emit(controller, JSON.stringify(chunk));
    };

    return new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        buffer += decoder.decode(bytes, { stream: true });
        const lines = buffer.split('\n');
        // String.split always returns at least one element.
        buffer = lines.pop()!;
        for (const line of lines) handleLine(line, controller);
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) handleLine(buffer, controller);
        flushPending(controller);
      },
    });
  }

  /** Returns the chunk to forward, or null to drop it. */
  private normalize(chunk: FoundryStreamChunk): FoundryStreamChunk | null {
    if (chunk.usage) Object.assign(this.usage, toTokenUsage(chunk.usage));

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    if (choices.length === 0 && !chunk.usage) {
      // Azure's prompt-annotation chunk: no choices, blank id/model.
      const results = chunk.prompt_filter_results ?? chunk.prompt_annotations;
      if (Array.isArray(results)) this.promptFilterResults.push(...results);
      return null;
    }

    // Async-filter annotation chunks carry id "", model "", created 0.
    if (chunk.id) this.id = chunk.id;
    else chunk.id = this.id;
    if (chunk.model) this.model = chunk.model;
    else chunk.model = this.model;
    if (chunk.created) this.created = chunk.created;
    else chunk.created = this.created;
    if (!chunk.object) chunk.object = 'chat.completion.chunk';

    for (const choice of choices) {
      choice.delta ??= {};
      if (this.extractThinkTags) this.splitChoice(choice, choice.delta);
    }
    return chunk;
  }

  private splitChoice(choice: FoundryStreamChoice, delta: FoundryStreamDelta): void {
    const index = choice.index ?? 0;
    let splitter = this.splitters.get(index);
    if (!splitter) {
      splitter = new ThinkTagSplitter();
      this.splitters.set(index, splitter);
    }

    const hasContent = typeof delta.content === 'string';
    const split = hasContent ? splitter.push(delta.content as string) : { content: '', reasoning: '' };
    if (choice.finish_reason) {
      const tail = splitter.flush();
      split.content += tail.content;
      split.reasoning += tail.reasoning;
    }

    if (hasContent || split.content) delta.content = split.content;
    if (split.reasoning) delta.reasoning_content = (delta.reasoning_content ?? '') + split.reasoning;
  }

  /** Synthesize chunks for text still held by splitters when the stream ends. */
  private drainSplitters(): FoundryStreamChunk[] {
    const chunks: FoundryStreamChunk[] = [];
    for (const [index, splitter] of this.splitters) {
      const { content, reasoning } = splitter.flush();
      if (!content && !reasoning) continue;
      chunks.push({
        id: this.id,
        object: 'chat.completion.chunk',
        created: this.created,
        model: this.model,
        choices: [
          {
            index,
            delta: reasoning ? { reasoning_content: reasoning } : { content },
            finish_reason: null,
          },
        ],
      });
    }
    return chunks;
  }
}
