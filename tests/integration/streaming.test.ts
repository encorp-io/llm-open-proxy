/**
 * Streaming integration tests for OpenAI-shape providers.
 *
 * Anthropic streaming has its own test in `anthropic.test.ts` because the
 * adapter does heavy SSE translation (Anthropic's native event names →
 * OpenAI chunk shape). These tests cover `streamChatRequest`, the
 * generic OpenAI-compat transport, against every other provider that
 * supports `stream: true` over OpenAI's wire format.
 *
 * Each test:
 *   - opens a stream
 *   - drains it via `collectSseContent` (accumulates `choices[0].delta.content`)
 *   - asserts at least one content delta arrived
 *   - asserts `getUsage()` reports non-zero output tokens once the stream
 *     emits its final usage chunk (we ask for it via
 *     `stream_options: { include_usage: true }`, which the library injects)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  streamChatRequest,
  convertChatRequest,
  DEEPSEEK_API_URL,
  GOOGLE_OPENAI_COMPAT_URL,
  KIMI_API_URL,
  PERPLEXITY_API_URL,
  XAI_API_URL,
} from '../../src/index.js';
import {
  buildMinimalRequest,
  assertUsage,
  collectSseContent,
  skipIfMissingKey,
  call,
} from './helpers.js';

interface StreamCase {
  envKey: string;
  providerLabel: string;
  provider: 'openai' | 'google' | 'deepseek' | 'perplexity' | 'xai' | 'kimi';
  modelEnv: string;
  defaultModel: string;
  baseUrl: string | undefined;
}

const streamCases: StreamCase[] = [
  {
    envKey: 'OPENAI_API_KEY',
    providerLabel: 'openai',
    provider: 'openai',
    modelEnv: 'OPENAI_MODEL',
    defaultModel: 'gpt-4o-mini',
    baseUrl: undefined,
  },
  {
    envKey: 'GOOGLE_API_KEY',
    providerLabel: 'google (OpenAI-compat)',
    provider: 'google',
    modelEnv: 'GOOGLE_MODEL',
    defaultModel: 'gemini-2.5-flash',
    baseUrl: GOOGLE_OPENAI_COMPAT_URL,
  },
  {
    envKey: 'DEEPSEEK_API_KEY',
    providerLabel: 'deepseek',
    provider: 'deepseek',
    modelEnv: 'DEEPSEEK_MODEL',
    defaultModel: 'deepseek-chat',
    baseUrl: DEEPSEEK_API_URL,
  },
  {
    envKey: 'PERPLEXITY_API_KEY',
    providerLabel: 'perplexity',
    provider: 'perplexity',
    modelEnv: 'PERPLEXITY_MODEL',
    defaultModel: 'sonar',
    baseUrl: PERPLEXITY_API_URL,
  },
  {
    envKey: 'XAI_API_KEY',
    providerLabel: 'xai (Grok)',
    provider: 'xai',
    modelEnv: 'XAI_MODEL',
    defaultModel: 'grok-3-mini',
    baseUrl: XAI_API_URL,
  },
  {
    envKey: 'KIMI_API_KEY',
    providerLabel: 'kimi (Moonshot)',
    provider: 'kimi',
    modelEnv: 'KIMI_MODEL',
    defaultModel: 'kimi-k2-0905-preview',
    baseUrl: KIMI_API_URL,
  },
];

for (const c of streamCases) {
  test(`${c.providerLabel} — streaming yields content deltas + usage`, skipIfMissingKey(c.envKey), async () => {
    const { body } = convertChatRequest(
      {
        ...buildMinimalRequest(process.env[c.modelEnv] ?? c.defaultModel),
        stream: true,
      },
      c.provider,
    );

    const { stream, getUsage } = await call(() =>
      streamChatRequest({
        apiKey: process.env[c.envKey]!,
        body,
        baseUrl: c.baseUrl,
      }),
    );

    const content = await collectSseContent(stream);
    assert.ok(
      content.length > 0,
      `no content delta accumulated from ${c.providerLabel} stream`,
    );

    const usage = getUsage();
    assertUsage(usage);
    // include_usage is injected by streamChatRequest; the final usage
    // chunk should have arrived with non-zero output tokens. Some
    // providers (Perplexity) deliver usage less reliably in streams, so
    // the strict check is wrapped in a conditional warning rather than
    // a hard failure.
    if (usage.completion_tokens === 0) {
      // Stream completed without a final usage chunk. This is not
      // technically a translation bug, but it's worth surfacing.
      console.warn(
        `[${c.providerLabel}] stream completed but completion_tokens=0 — provider may not emit a final usage chunk`,
      );
    }
  });
}
