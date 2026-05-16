import express from 'express';
import {
  UpstreamError,
  convertChatRequest,
  sendAnthropicRequest,
  sendChatRequest,
  streamAnthropicRequest,
  streamChatRequest,
  type CanonicalChatRequest,
  type ProviderName,
} from '@encorp.ai/llm-open-proxy';

function pickProvider(model: string): { provider: ProviderName; apiKey: string } {
  if (model.startsWith('claude')) {
    return { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY ?? '' };
  }
  if (model.startsWith('gemini')) {
    return { provider: 'google', apiKey: process.env.GOOGLE_API_KEY ?? '' };
  }
  if (model.startsWith('deepseek')) {
    return { provider: 'deepseek', apiKey: process.env.DEEPSEEK_API_KEY ?? '' };
  }
  return { provider: 'openai', apiKey: process.env.OPENAI_API_KEY ?? '' };
}

const app = express();
app.use(express.json({ limit: '4mb' }));

app.post('/v1/chat/completions', async (req, res) => {
  const body = req.body as CanonicalChatRequest;
  const { provider, apiKey } = pickProvider(body.model);

  try {
    if (body.stream) {
      const { stream } =
        provider === 'anthropic'
          ? await streamAnthropicRequest({ apiKey, body })
          : await streamChatRequest({
              apiKey,
              body: convertChatRequest(body, provider).body,
            });
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
      return;
    }

    const { response } =
      provider === 'anthropic'
        ? await sendAnthropicRequest({ apiKey, body })
        : await sendChatRequest({
            apiKey,
            body: convertChatRequest(body, provider).body,
          });
    res.json(response);
  } catch (err) {
    if (err instanceof UpstreamError) {
      res.status(err.statusCode).json({ error: { message: err.message } });
      return;
    }
    console.error(err);
    res.status(500).json({ error: { message: 'internal error' } });
  }
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`server listening on :${port}`));
