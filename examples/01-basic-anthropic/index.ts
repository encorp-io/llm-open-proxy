import { sendAnthropicRequest } from '@encorp/llm-open-proxy';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY first.');
  process.exit(1);
}

const { response, usage, warnings } = await sendAnthropicRequest({
  apiKey,
  body: {
    model: 'claude-opus-4-6',
    messages: [
      { role: 'system', content: 'You are a friendly assistant. Reply in one sentence.' },
      { role: 'user', content: 'Hi' },
    ],
    max_completion_tokens: 256,
  },
});

console.log('✔', response.choices[0]!.message.content);
console.log();
console.log('usage ', usage);
if (warnings.length) console.log('warns ', warnings);
