import { test } from 'node:test';
import {
  sendChatRequest,
  convertChatRequest,
  XAI_API_URL,
} from '../../src/index.js';
import {
  buildMinimalRequest,
  assertCanonicalResponse,
  assertUsage,
  skipIfMissingKey,
  call,
} from './helpers.js';

const apiKey = process.env.XAI_API_KEY ?? '';
const model = process.env.XAI_MODEL ?? 'grok-3-mini';

test('xai (Grok) — basic request returns canonical response', skipIfMissingKey('XAI_API_KEY'), async () => {
  // xAI speaks OpenAI's shape natively, so the conversion is mostly a no-op.
  const { body } = convertChatRequest(buildMinimalRequest(model), 'xai');
  const { response, usage } = await call(() =>
    sendChatRequest({
      apiKey,
      body,
      baseUrl: XAI_API_URL,
    }),
  );

  assertCanonicalResponse(response);
  assertUsage(usage);
});
