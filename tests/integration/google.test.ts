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
  call,
} from './helpers.js';

const apiKey = process.env.GOOGLE_API_KEY ?? '';
// `gemini-2.0-flash` was deprecated for new accounts in early 2026, so
// the default points at `gemini-2.5-flash` (currently available to new
// users). 2.5-flash uses internal thinking tokens, which is why the
// shared `buildMinimalRequest` caps output at 64 tokens rather than the
// historical 10 — that's the budget we leave for thinking before visible
// content. Override via GOOGLE_MODEL when Google rotates again.
const model = process.env.GOOGLE_MODEL ?? 'gemini-2.5-flash';

test('google (OpenAI-compat) — basic request returns canonical response', skipIfMissingKey('GOOGLE_API_KEY'), async () => {
  const { body } = convertChatRequest(buildMinimalRequest(model), 'google');
  const { response, usage } = await call(() =>
    sendChatRequest({
      apiKey,
      body,
      baseUrl: GOOGLE_OPENAI_COMPAT_URL,
    }),
  );

  assertCanonicalResponse(response);
  assertUsage(usage);
});
