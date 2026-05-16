# 01 — Basic Anthropic call

Sends an OpenAI-shape request to Anthropic. Notice that the *response*
comes back in OpenAI Chat Completion shape, not Anthropic's native shape —
the library translates both directions.

```bash
cp .env.example .env       # then edit .env and set ANTHROPIC_API_KEY
npm install
npm start
```

`npm start` passes `--env-file-if-exists=.env` to Node, so you can also
skip the `.env` file and just `export ANTHROPIC_API_KEY=...` in your shell
if you prefer.

Expected output:

```
✔ Hi! How can I help you today?

usage  { prompt_tokens: 16, completion_tokens: 12, total_tokens: 28 }
```

If you change the `model` field to `gpt-4o` and the call to
`sendChatRequest` (with `OPENAI_API_KEY`), the rest of the code is
identical — that's the point of having a canonical shape.
