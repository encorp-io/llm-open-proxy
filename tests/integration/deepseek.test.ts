import { test } from 'node:test';
import {
  sendChatRequest,
  convertChatRequest,
  DEEPSEEK_API_URL,
} from '../../src/index.js';
import {
  buildMinimalRequest,
  assertCanonicalResponse,
  assertUsage,
  skipIfMissingKey,
  call,
} from './helpers.js';

const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';

test('deepseek — basic request returns canonical response', skipIfMissingKey('DEEPSEEK_API_KEY'), async () => {
  const { body } = convertChatRequest(buildMinimalRequest(model), 'deepseek');
  const { response, usage } = await call(() =>
    sendChatRequest({
      apiKey,
      body,
      baseUrl: DEEPSEEK_API_URL,
    }),
  );

  assertCanonicalResponse(response);
  assertUsage(usage);
});
