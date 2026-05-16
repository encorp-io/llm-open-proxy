import { test } from 'node:test';
import {
  sendChatRequest,
  convertChatRequest,
  KIMI_API_URL,
} from '../../src/index.js';
import {
  buildMinimalRequest,
  assertCanonicalResponse,
  assertUsage,
  skipIfMissingKey,
  call,
} from './helpers.js';

const apiKey = process.env.KIMI_API_KEY ?? '';
const model = process.env.KIMI_MODEL ?? 'kimi-k2-0905-preview';

test('kimi (Moonshot) — basic request returns canonical response', skipIfMissingKey('KIMI_API_KEY'), async () => {
  // Kimi reuses OpenAI's config, just with a different base URL.
  const { body } = convertChatRequest(buildMinimalRequest(model), 'kimi');
  const { response, usage } = await call(() =>
    sendChatRequest({
      apiKey,
      body,
      baseUrl: KIMI_API_URL,
    }),
  );

  assertCanonicalResponse(response);
  assertUsage(usage);
});
