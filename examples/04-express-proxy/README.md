# 04 — Drop-in Express proxy server

A complete `/v1/chat/completions` HTTP endpoint that:

- accepts OpenAI-format requests (so any OpenAI client SDK works)
- routes to the correct provider based on the `model` field's prefix
- supports both streaming (`stream: true`) and non-streaming responses
- maps `UpstreamError` to the correct HTTP status

This is the smallest example of *what the npm package is for*: providing
the building blocks to build your own multi-provider gateway in 80 lines
of code.

```bash
cp .env.example .env       # then edit .env and set the keys for the
                           # providers you want to route to
npm install
npm start
# server listening on :3000
```

Try it from another terminal with the official OpenAI SDK:

```ts
import OpenAI from 'openai';
const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: 'unused',
});
const r = await client.chat.completions.create({
  model: 'claude-opus-4-6',
  messages: [{ role: 'user', content: 'Hi' }],
});
console.log(r.choices[0].message.content);
```

The OpenAI SDK doesn't know it's talking to Anthropic. That's the whole
point of the canonical shape.
