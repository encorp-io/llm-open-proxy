# @encorp.ai/llm-open-proxy

> One LLM request shape. Every provider.

OpenAI-canonical request/response translator for the major LLM providers.
Write your code once in OpenAI Chat Completions shape and forward it to
**Anthropic, Google Gemini, DeepSeek, Perplexity, xAI, or Moonshot Kimi** —
with proper parameter mapping, message reshape, tool-call translation,
and SSE streaming bridge.

[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)](#tests)
[![Zero deps](https://img.shields.io/badge/runtime%20deps-0-blue)](#)
[![License](https://img.shields.io/badge/license-MIT-blue)](#license)
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
Perplexity, xAI, and Kimi — just swap the function and the model id.

## Table of contents

- [Why this package](#why-this-package)
- [How it compares](#how-it-compares)
- [Three layers of API](#three-layers-of-api)
- [Streaming](#streaming-sse)
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

## What gets translated

| Canonical field        | OpenAI                        | Anthropic                                                  | Google | DeepSeek                          | Perplexity        |
|------------------------|-------------------------------|------------------------------------------------------------|--------|-----------------------------------|-------------------|
| `temperature`          | ✓ (locked on o-series/GPT-5)  | clamped to ≤ 1.0                                           | ✓      | ✓                                 | ✓                 |
| `top_p` / `top_k`      | top_p only                    | both                                                       | both   | top_p only                        | top_p only        |
| `max_completion_tokens`| ✓                             | renamed to `max_tokens` (required, defaulted to 4096)      | ✓      | renamed to `max_tokens`           | renamed           |
| `stop`                 | ✓                             | renamed to `stop_sequences`                                | ✓      | ✓                                 | ✓                 |
| `tools`, `tool_choice` | ✓                             | reshaped to `input_schema` + `{type, name}`                | ✓      | ✓                                 | tool_choice dropped |
| `response_format`      | ✓                             | translated to `output_config`                              | ✓      | ✓                                 | ✓                 |
| `reasoning_effort`     | ✓                             | mapped to `thinking.budget_tokens`                         | ✓      | mapped to `thinking.reasoning_effort` | ✓             |
| Message reshape        | —                             | system extraction, tool_use/tool_result blocks, image blocks | —    | preserves `reasoning_content`     | —                 |
| Response → canonical   | —                             | `tool_use` → `tool_calls`, stop_reason mapping             | —      | —                                 | —                 |
| Streaming SSE bridge   | passthrough                   | full Anthropic→OpenAI event translation                    | passthrough | passthrough                  | passthrough       |

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
npm test               # build + run (199 tests, ~0.5s)
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
| 4 | [`04-express-proxy`](./examples/04-express-proxy) | Drop-in Express HTTP gateway |

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
