# 02 — Streaming (Anthropic upstream → OpenAI SSE format)

Calls Anthropic with `stream: true` and consumes the stream the library
returns. The bytes coming out are **OpenAI-format SSE chunks**
(`data: {choices: [{delta: {content: "..."}}]}\n\n`), even though the
upstream is Anthropic — the library translates the SSE event names and
shapes on the fly.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm install
npm start
```

The example also shows `getUsage()` — the running usage counter the
library exposes alongside the stream. After the stream ends it has the
final token counts pulled from the `message_delta` event.
