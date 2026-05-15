import {
  UpstreamError,
  convertChatRequest,
  isRetryableUpstreamStatus,
  sendAnthropicRequest,
  sendChatRequest,
  type CanonicalChatRequest,
  type CanonicalChatResponse,
  type ProviderName,
} from '@encorp/llm-open-proxy';

interface RouteEntry {
  provider: ProviderName;
  model: string;
  apiKey: string;
}

// In your real app this comes from a DB / config service.
const fallbackChain: RouteEntry[] = [
  {
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: process.env.OPENAI_API_KEY ?? '',
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
  },
];

async function dispatchOnce(
  entry: RouteEntry,
  body: CanonicalChatRequest,
): Promise<CanonicalChatResponse> {
  const targeted: CanonicalChatRequest = { ...body, model: entry.model };
  if (entry.provider === 'anthropic') {
    const { response } = await sendAnthropicRequest({ apiKey: entry.apiKey, body: targeted });
    return response;
  }
  const { body: upstream } = convertChatRequest(targeted, entry.provider);
  const { response } = await sendChatRequest({ apiKey: entry.apiKey, body: upstream });
  return response;
}

async function dispatchWithFallback(body: CanonicalChatRequest): Promise<{
  response: CanonicalChatResponse;
  servedBy: RouteEntry;
  failures: Array<{ entry: RouteEntry; statusCode: number; message: string }>;
}> {
  const failures: Array<{ entry: RouteEntry; statusCode: number; message: string }> = [];
  for (let i = 0; i < fallbackChain.length; i++) {
    const entry = fallbackChain[i]!;
    const isLast = i === fallbackChain.length - 1;
    try {
      const response = await dispatchOnce(entry, body);
      return { response, servedBy: entry, failures };
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      failures.push({ entry, statusCode: err.statusCode, message: err.message });
      if (!isRetryableUpstreamStatus(err.statusCode) || isLast) throw err;
    }
  }
  throw new Error('unreachable');
}

const { response, servedBy, failures } = await dispatchWithFallback({
  model: 'irrelevant', // overridden by router
  messages: [{ role: 'user', content: 'Say hi.' }],
  max_completion_tokens: 64,
});

console.log(`✔ served by ${servedBy.provider} (${servedBy.model})`);
console.log(response.choices[0]!.message.content);
if (failures.length) {
  console.log('\nfallbacks:');
  for (const f of failures) console.log(`  ${f.entry.provider} → ${f.statusCode} ${f.message}`);
}
