import { streamAnthropicRequest } from '@encorp/llm-open-proxy';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY first.');
  process.exit(1);
}

const { stream, getUsage } = await streamAnthropicRequest({
  apiKey,
  body: {
    model: 'claude-opus-4-6',
    messages: [{ role: 'user', content: 'Count from 1 to 10, one per line.' }],
    max_completion_tokens: 256,
  },
});

const reader = stream.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const text = decoder.decode(value, { stream: true });

  // Translate the OpenAI-format SSE chunks back into plain text for the demo.
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6);
    if (payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload) as {
        choices: Array<{ delta: { content?: string } }>;
      };
      const delta = chunk.choices[0]?.delta.content;
      if (delta) process.stdout.write(delta);
    } catch {
      // partial chunk
    }
  }
}

console.log('\n');
console.log('usage', getUsage());
