# @encorp.ai/llm-open-proxy

> One LLM request shape. Every provider.

OpenAI-canonical request/response translator for the major LLM providers.
Write your code once in OpenAI Chat Completions shape and forward it to
**Anthropic, Google Gemini, DeepSeek, Perplexity, xAI, Moonshot Kimi, or
Microsoft Foundry** (Azure OpenAI, Foundry Models, and Claude on Foundry) —
with proper parameter mapping, message reshape, tool-call translation,
and SSE streaming bridge.

[![npm version](https://img.shields.io/npm/v/@encorp.ai/llm-open-proxy.svg)](https://www.npmjs.com/package/@encorp.ai/llm-open-proxy)
[![CI](https://github.com/encorp-io/llm-open-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/encorp-io/llm-open-proxy/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)](#tests)
[![Zero deps](https://img.shields.io/badge/runtime%20deps-0-blue)](#)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-green)](#)

**[📖 Docs site →](https://encorp-io.github.io/llm-open-proxy)** ·
**[🧬 OpenAPI spec →](https://encorp-io.github.io/llm-open-proxy/openapi.html)** ·
**[🔬 TypeScript API →](https://encorp-io.github.io/llm-open-proxy/typedoc/)** ·
**[💻 Examples →](./examples)**

---

## 30-second quickstart

```bash
npm i @encorp.ai/llm-open-proxy
```

```ts
import { sendAnthropicRequest } from '@encorp.ai/llm-open-proxy';

const { response, usage, warnings } = await sendAnthropicRequest({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  body: {
    model: 'claude-opus-4-6',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ],
    max_completion_tokens: 256,
  },
});

console.log(response.choices[0].message.content);
// `response` is OpenAI-shaped, regardless of upstream.
```

That's it. Same code structure works for OpenAI, Google, DeepSeek,
Perplexity, xAI, Kimi, and Microsoft Foundry — just swap the function and
the model id.

## Table of contents

- [Why this package](#why-this-package)
- [How it compares](#how-it-compares)
- [Three layers of API](#three-layers-of-api)
- [Streaming](#layer-3--streaming)
- [Microsoft Foundry](#microsoft-foundry)
- [What gets translated](#what-gets-translated)
- [Provider-specific escape hatch](#provider-specific-escape-hatch)
- [Retry policy helper](#retry-policy-helper)
- [Tree-shaking](#tree-shaking)
- [Tests](#tests)
- [Examples](#examples)
- [Status](#status)

## Why this package

Most "AI SDK" libraries give you one of two things:

- a **client SDK** that wraps one provider's API in a more ergonomic shape, or
- a **unified abstraction** that defines its own request shape and forces
  every model behind a lowest-common-denominator API.

Neither is what you want when you're building a **proxy / gateway**. A
proxy receives a real OpenAI request (from a client library that already
exists, like the OpenAI SDK or LangChain) and has to forward it to
whichever upstream the operator chose, **preserving all the fields the
upstream supports and dropping the ones it doesn't** — with proper
warnings, not silent corruption.

This library does exactly that, and only that.

## How it compares

|                             | `@encorp.ai/llm-open-proxy` | Vercel AI SDK | LangChain | OpenRouter / Portkey |
|-----------------------------|:------------------------:|:-------------:|:---------:|:--------------------:|
| OpenAI request shape in     | ✓                        | ✗ (own shape) | ✗         | ✓ (hosted)           |
| Provider-native body out    | ✓                        | ✓ via SDKs    | ✓         | hosted               |
| Streaming SSE bridge        | ✓                        | ✓             | ✓         | hosted               |
| Tool-call translation       | ✓                        | ✓             | ✓         | hosted               |
| Self-hosted                 | ✓                        | ✓             | ✓         | ✗ (or paid)          |
| Runtime dependencies        | **0**                    | many          | many      | n/a                  |
| Bundle size                 | tiny                     | medium        | large     | n/a                  |
| You own the routing logic   | ✓                        | partially     | partially | ✗                    |

If you want a **library** that does *just* the request/response
translation and lets you build the rest yourself — this is for you. If
you want a turnkey hosted gateway, use OpenRouter or Portkey.

## Three layers of API

Pick whichever fits. They build on each other.

### Layer 1 — pure conversion

```ts
import { convertChatRequest } from '@encorp.ai/llm-open-proxy';

const { body, warnings } = convertChatRequest(canonical, 'anthropic');
// `body` is Anthropic-shaped. POST it yourself.
```

### Layer 2 — transport + response translation

```ts
import { sendAnthropicRequest, sendChatRequest, GOOGLE_OPENAI_COMPAT_URL } from '@encorp.ai/llm-open-proxy';

// Anthropic
const { response, usage, warnings } = await sendAnthropicRequest({ apiKey, body: canonical });

// Google (and any other OpenAI-compatible upstream)
const { body } = convertChatRequest(canonical, 'google');
const { response } = await sendChatRequest({ apiKey, body, baseUrl: GOOGLE_OPENAI_COMPAT_URL });
```

### Layer 3 — streaming

```ts
import { streamAnthropicRequest } from '@encorp.ai/llm-open-proxy';

const { stream, getUsage } = await streamAnthropicRequest({ apiKey, body: canonical });
// `stream` emits OpenAI-format SSE chunks. Pipe to the client unchanged.
return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
```

See [`examples/`](./examples) for runnable mini-projects covering each layer.

## Microsoft Foundry

[Microsoft Foundry](https://learn.microsoft.com/azure/foundry/) (formerly
Azure AI Foundry) serves Azure OpenAI models, the non-OpenAI Foundry Models
(DeepSeek, Grok, Llama, Mistral, MAI, …) and Claude from one resource,
behind several wire protocols. `sendFoundryRequest` / `streamFoundryRequest`
take a canonical request and handle routing, auth, translation and the
Azure-specific response quirks. `model` is always the **deployment name**.

```ts
import { sendFoundryRequest, streamFoundryRequest } from '@encorp.ai/llm-open-proxy';

// Azure OpenAI or any Foundry Model, via the v1 API (the default)
const { response, usage, warnings } = await sendFoundryRequest({
  endpoint: 'https://my-resource.services.ai.azure.com',
  apiKey: process.env.FOUNDRY_API_KEY!,
  body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hello' }] },
});

// Claude on Foundry — same call, Anthropic translation underneath
await sendFoundryRequest({
  endpoint: 'https://my-resource.services.ai.azure.com',
  api: 'anthropic',
  apiKey: process.env.FOUNDRY_API_KEY!,
  body: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'Hello' }] },
});
```

| `api`                        | Endpoint                                                          | Notes                                                              |
|------------------------------|-------------------------------------------------------------------|--------------------------------------------------------------------|
| `openai-v1` *(default)*      | `{endpoint}/openai/v1/chat/completions`                           | Recommended. Azure OpenAI + Foundry Models. No `api-version`.      |
| `openai-deployments`         | `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…` | Dated API. Defaults to GA `2024-10-21`; pass a `-preview` `apiVersion` for `reasoning_effort` / stream usage. |
| `model-inference`            | `{endpoint}/models/chat/completions?api-version=…`                | Deprecated Azure AI Model Inference API. Legacy only.              |
| `anthropic`                  | `{endpoint}/anthropic/v1/messages`                                | Claude. Full Anthropic ↔ OpenAI translation, incl. streaming.     |

`endpoint` can be a resource (`https://x.services.ai.azure.com`,
`https://x.openai.azure.com`) or a project endpoint
(`…/api/projects/my-project`). For anything else — APIM fronts, legacy
serverless or managed-compute endpoints — pass a full `url` instead.

**Auth.** Pass `apiKey` (sent as `api-key`; `x-api-key` for Claude) or a
Microsoft Entra ID token provider. The library has no dependency on
`@azure/identity`; plug it in yourself:

```ts
import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import { FOUNDRY_ENTRA_SCOPE } from '@encorp.ai/llm-open-proxy';

await sendFoundryRequest({
  endpoint,
  getToken: getBearerTokenProvider(new DefaultAzureCredential(), FOUNDRY_ENTRA_SCOPE),
  body,
});
```

`FOUNDRY_ENTRA_SCOPE` (`https://ai.azure.com/.default`) is what the Foundry
docs specify; the dated and Model Inference APIs historically use
`AZURE_COGNITIVE_SERVICES_SCOPE`.

**What the adapter normalizes for you:**

- **Reasoning models.** Azure OpenAI reasoning deployments (o-series,
  gpt-5 — detected by deployment name) get `temperature`, `top_p`,
  penalties, `logit_bias` and logprobs dropped with warnings. DeepSeek-R1
  and similar models that inline a leading `<think>…</think>` block have it
  moved into `reasoning_content`, in both non-streaming and streaming
  responses (disable with `extractThinkTags: false`).
- **Streaming.** Azure's first chunk is a choice-less prompt annotation with
  a blank id; it is dropped (its verdicts stay available via
  `getPromptFilterResults()`). Async-filter annotation chunks get their
  blank `id` / `model` / `created` backfilled and an empty `delta`, so
  OpenAI clients that read `choices[0].delta` don't break. Usage is
  requested via `stream_options` wherever the API supports it.
- **Content safety.** `prompt_filter_results` and per-choice
  `content_filter_results` pass through on `FoundryChatResponse` (typed). A
  400 content-filter rejection surfaces as `UpstreamError`;
  `getFoundryContentFilterError(err)` returns its message and category
  verdicts, reading both of Azure's error spellings.
- **Errors.** Every Azure error envelope yields a readable message, and the
  `retry-after-ms` / `retry-after` back-off hint lands on
  `UpstreamError.retryAfterMs` (on every transport, not just Foundry).
- **Model Inference API.** `max_completion_tokens` → `max_tokens`, `stop`
  wrapped as an array, out-of-schema fields dropped. Set `extraParameters:
  'pass-through'` to forward model-specific fields from
  `provider_options.foundry`.

Layer 1 works too: `convertChatRequest(canonical, 'foundry')` targets the
OpenAI-compatible surfaces, and `convertFoundryRequest(canonical, { api })`
targets any of them. `buildFoundryUrl` builds the matching URL.

## What gets translated

| Canonical field        | OpenAI                        | Anthropic                                                  | Google | DeepSeek                          | Perplexity        | Foundry (OpenAI APIs)¹                         |
|------------------------|-------------------------------|------------------------------------------------------------|--------|-----------------------------------|-------------------|------------------------------------------------|
| `temperature`          | ✓ (locked on o-series/GPT-5)  | clamped to ≤ 1.0                                           | ✓      | ✓                                 | ✓                 | ✓ (dropped on reasoning deployments)           |
| `top_p` / `top_k`      | top_p only                    | both                                                       | both   | top_p only                        | top_p only        | top_p only                                     |
| `max_completion_tokens`| ✓                             | renamed to `max_tokens` (required, defaulted to 4096)      | ✓      | renamed to `max_tokens`           | renamed           | ✓ (`max_tokens` on Model Inference)            |
| `stop`                 | ✓                             | renamed to `stop_sequences`                                | ✓      | ✓                                 | ✓                 | ✓                                              |
| `tools`, `tool_choice` | ✓                             | reshaped to `input_schema` + `{type, name}`                | ✓      | ✓                                 | tool_choice dropped | ✓                                            |
| `response_format`      | ✓                             | translated to `output_config`                              | ✓      | ✓                                 | ✓                 | ✓                                              |
| `reasoning_effort`     | ✓                             | mapped to `thinking.budget_tokens`                         | ✓      | mapped to `thinking.reasoning_effort` | ✓             | ✓ (dropped on GA dated / Model Inference)      |
| Message reshape        | —                             | system extraction, tool_use/tool_result blocks, image blocks | —    | preserves `reasoning_content`     | —                 | —                                              |
| Response → canonical   | —                             | `tool_use` → `tool_calls`, stop_reason mapping             | —      | —                                 | —                 | leading `<think>` → `reasoning_content`        |
| Streaming SSE bridge   | passthrough                   | full Anthropic→OpenAI event translation                    | passthrough | passthrough                  | passthrough       | Azure filter-chunk normalization               |

¹ Claude on Foundry (`api: 'anthropic'`) uses the Anthropic column.

Every dropped / clamped / renamed field is reported in the `warnings`
array, so you can surface them to operators in logs. Nothing fails
silently.

## Provider-specific escape hatch

If you need to forward a field the canonical shape doesn't cover, attach
it under `provider_options`. Only the entry matching the active provider
is merged into the upstream body:

```ts
convertChatRequest({
  model: 'claude-opus-4-6',
  messages: [...],
  provider_options: {
    anthropic: { metadata: { user_id: 'u_42' } },
    openai: { service_tier: 'priority' },
  },
}, 'anthropic');
// body.metadata = { user_id: 'u_42' }; the openai entry is ignored.
```

## Retry policy helper

```ts
import { isRetryableUpstreamStatus, UpstreamError } from '@encorp.ai/llm-open-proxy';

try {
  return await sendChatRequest({ apiKey, body });
} catch (err) {
  if (err instanceof UpstreamError && isRetryableUpstreamStatus(err.statusCode)) {
    // 408, 429, 5xx, 404 — safe to retry against a fallback model
  }
  throw err;
}
```

`true` for 408, 429, 5xx, 404. `false` for client-side problems (400, 401,
403, 422), since retrying those against any upstream will fail the same
way. See [`examples/03-multi-provider`](./examples/03-multi-provider)
for a full fallback-chain implementation.

## Tree-shaking

Each provider is exposed as a separate entry point so you only pull in
what you use:

```ts
import { anthropicChatConfig } from '@encorp.ai/llm-open-proxy/providers/anthropic';
```

## Tests

The suite uses Node's built-in test runner — no test-framework dependency.

```bash
npm test               # build + run (299 tests, ~0.5s)
npm run test:coverage  # build + run with 100% line/branch/function coverage
```

Coverage is enforced at 100% for line, branch and function, across the
engine, every provider config, the OpenAI/Anthropic transports, and the
SSE-bridge translator. Transport tests stub `globalThis.fetch` so they
run hermetically.

## Examples

| # | Folder | Demonstrates |
|---|---|---|
| 1 | [`01-basic-anthropic`](./examples/01-basic-anthropic) | One-shot Anthropic call with response translation |
| 2 | [`02-streaming`](./examples/02-streaming) | OpenAI-format SSE produced from an Anthropic upstream |
| 3 | [`03-multi-provider`](./examples/03-multi-provider) | Multi-provider router with retry-on-5xx fallback |
| 4 | [`04-express-proxy`](./examples/04-express-proxy) | Drop-in Express HTTP gateway (incl. Microsoft Foundry routing) |

## Generating the docs locally

```bash
./scripts/build-docs.sh
npx --yes http-server _site -p 8080 -o
```

The CI workflow at `.github/workflows/docs.yml` does the same on every
push to `main` and deploys to GitHub Pages.

## Status

`0.x` — API may still change. Chat completions only. Audio, images, and
embeddings translation are out of scope for v1 because they are far more
provider-specific (and most use cases just call the native provider SDK
for those modalities anyway).

## License

MIT
