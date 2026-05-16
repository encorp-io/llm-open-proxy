import { test } from 'node:test';
import {
  sendChatRequest,
  convertChatRequest,
  PERPLEXITY_API_URL,
} from '../../src/index.js';
import {
  buildMinimalRequest,
  assertCanonicalResponse,
  assertUsage,
  skipIfMissingKey,
  call,
} from './helpers.js';

const apiKey = process.env.PERPLEXITY_API_KEY ?? '';
const model = process.env.PERPLEXITY_MODEL ?? 'sonar';

test('perplexity — basic request returns canonical response', skipIfMissingKey('PERPLEXITY_API_KEY'), async () => {
  const { body } = convertChatRequest(buildMinimalRequest(model), 'perplexity');
  const { response, usage } = await call(() =>
    sendChatRequest({
      apiKey,
      body,
      baseUrl: PERPLEXITY_API_URL,
    }),
  );

  assertCanonicalResponse(response);
  assertUsage(usage);
});
