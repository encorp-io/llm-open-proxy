import { test } from 'node:test';
import { sendChatRequest, convertChatRequest } from '../../src/index.js';
import {
  buildMinimalRequest,
  assertCanonicalResponse,
  assertUsage,
  skipIfMissingKey,
} from './helpers.js';

const apiKey = process.env.OPENAI_API_KEY ?? '';
const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

test('openai — basic request returns canonical response', skipIfMissingKey('OPENAI_API_KEY'), async () => {
  const { body } = convertChatRequest(buildMinimalRequest(model), 'openai');
  const { response, usage } = await sendChatRequest({ apiKey, body });

  assertCanonicalResponse(response);
  assertUsage(usage);
});
