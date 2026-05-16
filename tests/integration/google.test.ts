import { test } from 'node:test';
import {
  sendChatRequest,
  convertChatRequest,
  GOOGLE_OPENAI_COMPAT_URL,
} from '../../src/index.js';
import {
  buildMinimalRequest,
  assertCanonicalResponse,
  assertUsage,
  skipIfMissingKey,
} from './helpers.js';

const apiKey = process.env.GOOGLE_API_KEY ?? '';
const model = process.env.GOOGLE_MODEL ?? 'gemini-2.5-flash';

test('google (OpenAI-compat) — basic request returns canonical response', skipIfMissingKey('GOOGLE_API_KEY'), async () => {
  const { body } = convertChatRequest(buildMinimalRequest(model), 'google');
  const { response, usage } = await sendChatRequest({
    apiKey,
    body,
    baseUrl: GOOGLE_OPENAI_COMPAT_URL,
  });

  assertCanonicalResponse(response);
  assertUsage(usage);
});
