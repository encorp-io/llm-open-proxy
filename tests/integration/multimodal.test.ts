/**
 * Multimodal (image input) integration tests.
 *
 * Tests the `image_url` content part translation:
 *
 *   - OpenAI / Google / xAI / Kimi: pure passthrough — the canonical
 *     `image_url` content part is OpenAI's native shape.
 *   - Anthropic: the library has to translate `{ type: 'image_url', image_url: { url } }`
 *     into Anthropic's `{ type: 'image', source: { type: 'url' | 'base64', ... } }`
 *     block. Data URIs (`data:image/png;base64,...`) are split into the
 *     base64 source format; regular HTTPS URLs become the url source
 *     format. This translation is hand-rolled and has historically
 *     been a bug surface.
 *
 * We use a 1x1 transparent PNG embedded as a data URI so the test has
 * no external network dependency beyond the upstream API itself. The
 * model may say "I can't describe this single pixel" — that's fine.
 * What we're checking is that the wire format reached the upstream
 * intact, which manifests as a 2xx response in canonical shape rather
 * than an `invalid image` error from the upstream.
 */

import { test } from 'node:test';
import {
  sendAnthropicRequest,
  sendChatRequest,
  convertChatRequest,
} from '../../src/index.js';
import {
  TINY_IMAGE_DATA_URI,
  assertCanonicalResponse,
  assertUsage,
  skipIfMissingKey,
  call,
} from './helpers.js';

const VISION_PROMPT = [
  {
    role: 'user' as const,
    content: [
      { type: 'text' as const, text: 'In two words, what do you see?' },
      {
        type: 'image_url' as const,
        image_url: { url: TINY_IMAGE_DATA_URI },
      },
    ],
  },
];

test('anthropic — accepts image_url data URI and translates to image source block', skipIfMissingKey('ANTHROPIC_API_KEY'), async () => {
  const { response, usage } = await call(() =>
    sendAnthropicRequest({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      body: {
        model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
        messages: VISION_PROMPT,
        max_completion_tokens: 64,
      },
    }),
  );

  assertCanonicalResponse(response);
  assertUsage(usage);
});

test('openai — accepts image_url data URI on a vision-capable model', skipIfMissingKey('OPENAI_API_KEY'), async () => {
  // gpt-4o-mini accepts image inputs; o-mini-only models do not. Override
  // via OPENAI_MODEL if you want to point at a different vision model.
  const { body } = convertChatRequest(
    {
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      messages: VISION_PROMPT,
      max_completion_tokens: 64,
    },
    'openai',
  );
  const { response, usage } = await call(() =>
    sendChatRequest({
      apiKey: process.env.OPENAI_API_KEY!,
      body,
    }),
  );

  assertCanonicalResponse(response);
  assertUsage(usage);
});
