# Examples

Each example is a standalone runnable mini-project. Copy `.env.example`
to `.env` and fill in the API keys it asks for, then `npm install && npm
start` inside the folder. The `start` script passes
`--env-file-if-exists=.env` to Node, so shell-exported env vars also
work if you prefer not to write a `.env` file.

| # | Folder | Demonstrates |
|---|---|---|
| 1 | [`01-basic-anthropic`](./01-basic-anthropic) | One-shot Anthropic call using `sendAnthropicRequest`. Shows that the response comes back in OpenAI shape. |
| 2 | [`02-streaming`](./02-streaming) | OpenAI-format SSE stream produced from an Anthropic upstream. |
| 3 | [`03-multi-provider`](./03-multi-provider) | A small router with retry-on-5xx that falls back from OpenAI to Anthropic, built on `convertChatRequest` + `isRetryableUpstreamStatus`. |
| 4 | [`04-express-proxy`](./04-express-proxy) | Drop-in HTTP gateway: an Express server that exposes `/v1/chat/completions` and routes by model prefix. |

> All examples assume the package is published to npm. If you're working
> against this monorepo locally, use `npm install ../..` (file path) inside
> each example, or wire up workspaces.
