# Integration tests

End-to-end tests that hit **real upstream APIs**. They prove the
library still talks correctly to each provider's wire format after
upstream-side changes (model deprecations, header tweaks, SSE schema
changes, etc.) — something the mocked unit suite in `__tests__/` cannot
catch.

## ⚠️ These cost real money and are opt-in

- Tests are skipped automatically when the relevant API key env var is
  unset. Run them only against the providers you have keys for.
- Each test deliberately stays tiny (system prompt + 1-line user prompt,
  `max_completion_tokens=10`). Running the whole suite once against
  every provider should cost a fraction of a cent.
- They are **not** run in CI by default. The repo's GitHub Actions
  workflow runs the unit suite only. To run integration tests in CI,
  add the keys as GitHub Action secrets and a manual workflow that calls
  `npm run test:integration`.

## Running locally

```bash
# 1. Set the keys for the providers you want to exercise
cp .env.example .env
# … edit .env …

# 2. Run the whole integration suite (skipped providers are reported as such)
npm run test:integration

# 3. Or target one file:
npm run test:integration -- '.test-build-integration/tests/integration/anthropic.test.js'
```

## Overriding the model used per provider

Each test picks a cheap, fast model by default. To override:

```bash
ANTHROPIC_MODEL=claude-opus-4-6 npm run test:integration
OPENAI_MODEL=gpt-4o-mini       npm run test:integration
GOOGLE_MODEL=gemini-2.5-flash  npm run test:integration
DEEPSEEK_MODEL=deepseek-chat   npm run test:integration
PERPLEXITY_MODEL=sonar         npm run test:integration
XAI_MODEL=grok-3-mini          npm run test:integration
KIMI_MODEL=kimi-k2-0905-preview npm run test:integration
```

If a model id is rejected by the upstream, the test fails with the
upstream's exact error message — useful for keeping the defaults
current.

## What each test asserts

- The HTTP call succeeds (no `UpstreamError`).
- The returned `response` is OpenAI-shape (has `choices[0].message.content`).
- `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens`
  are all non-negative numbers.
- For Anthropic specifically: the message reshape (system extraction,
  tool-call translation) round-trips correctly.
- For streaming: SSE chunks arrive, content accumulates, the final
  `getUsage()` reports non-zero tokens.

These are **smoke tests**, not behavioral tests. If a model's response
is technically correct but unexpected (e.g. it ignores the system
prompt), the test still passes. The goal is "the wire format and
translation still work", not "the model said the right thing".
