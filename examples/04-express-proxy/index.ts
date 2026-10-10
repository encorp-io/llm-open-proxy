import express from 'express';
import {
  UpstreamError,
  convertChatRequest,
  sendAnthropicRequest,
  sendChatRequest,
  sendFoundryRequest,
  streamAnthropicRequest,
  streamChatRequest,
  streamFoundryRequest,
  type CanonicalChatRequest,
  type FoundrySendOptions,
  type ProviderName,
} from '@encorp.ai/llm-open-proxy';

/** Microsoft Foundry deployments are addressed as `foundry/<deployment-name>`. */
const FOUNDRY_PREFIX = 'foundry/';

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

function foundryOptions(body: CanonicalChatRequest): FoundrySendOptions {
  const deployment = body.model.slice(FOUNDRY_PREFIX.length);
  return {
    endpoint: process.env.FOUNDRY_ENDPOINT ?? '',
    apiKey: process.env.FOUNDRY_API_KEY ?? '',
    // Claude deployments speak the Anthropic Messages API; everything else
    // (Azure OpenAI, DeepSeek, Grok, Llama, …) goes through the v1 API.
    api: deployment.startsWith('claude') ? 'anthropic' : 'openai-v1',
    body: { ...body, model: deployment },
  };
}

async function pipeSse(stream: ReadableStream<Uint8Array>, res: express.Response): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

const app = express();
app.use(express.json({ limit: '4mb' }));

app.post('/v1/chat/completions', async (req, res) => {
  const body = req.body as CanonicalChatRequest;

  try {
    if (body.model.startsWith(FOUNDRY_PREFIX)) {
      const opts = foundryOptions(body);
      if (body.stream) {
        await pipeSse((await streamFoundryRequest(opts)).stream, res);
        return;
      }
      res.json((await sendFoundryRequest(opts)).response);
      return;
    }

    const { provider, apiKey } = pickProvider(body.model);
    if (body.stream) {
      const { stream } =
        provider === 'anthropic'
          ? await streamAnthropicRequest({ apiKey, body })
          : await streamChatRequest({
              apiKey,
              body: convertChatRequest(body, provider).body,
            });
      await pipeSse(stream, res);
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
      // Pass the upstream's back-off hint on to the client (e.g. Azure 429s).
      if (err.retryAfterMs !== undefined) {
        res.setHeader('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
      }
      res.status(err.statusCode).json({ error: { message: err.message } });
      return;
    }
    console.error(err);
    res.status(500).json({ error: { message: 'internal error' } });
  }
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`server listening on :${port}`));
