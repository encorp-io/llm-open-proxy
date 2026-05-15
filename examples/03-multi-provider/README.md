# 03 — Multi-provider router with fallback

A 40-line router that:

1. Resolves a model id (e.g. `claude-opus-4-6`) to a provider (e.g. Anthropic).
2. Tries the request against that provider.
3. On a retryable upstream error (5xx/429/408/404), falls back to the next
   provider in the chain.
4. Returns the canonical OpenAI response.

The library's pieces used here:

- `convertChatRequest` — OpenAI canonical → provider body
- `sendChatRequest` / `sendAnthropicRequest` — transport
- `UpstreamError` + `isRetryableUpstreamStatus` — error classification

```bash
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
npm install
npm start
```

This is a starting point — your real app would track which provider
served each request, log timing, etc. The library deliberately stays out
of that to remain framework-agnostic.
