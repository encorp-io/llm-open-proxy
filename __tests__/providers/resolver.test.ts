import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  getProviderConfig,
  openaiChatConfig,
  googleChatConfig,
  anthropicChatConfig,
  deepseekChatConfig,
  perplexityChatConfig,
} from '../../src/providers/index.js';

describe('getProviderConfig', () => {
  it('returns the OpenAI config for openai/xai/kimi (folded under canonical openai)', () => {
    for (const p of ['openai', 'xai', 'kimi'] as const) {
      const r = getProviderConfig(p);
      assert.equal(r.config, openaiChatConfig);
      assert.equal(r.canonicalProvider, 'openai');
    }
  });

  it('returns the Google config for google', () => {
    const r = getProviderConfig('google');
    assert.equal(r.config, googleChatConfig);
    assert.equal(r.canonicalProvider, 'google');
  });

  it('returns the Anthropic config for anthropic', () => {
    const r = getProviderConfig('anthropic');
    assert.equal(r.config, anthropicChatConfig);
    assert.equal(r.canonicalProvider, 'anthropic');
  });

  it('returns the DeepSeek config for deepseek', () => {
    const r = getProviderConfig('deepseek');
    assert.equal(r.config, deepseekChatConfig);
    assert.equal(r.canonicalProvider, 'deepseek');
  });

  it('returns the Perplexity config for perplexity', () => {
    const r = getProviderConfig('perplexity');
    assert.equal(r.config, perplexityChatConfig);
    assert.equal(r.canonicalProvider, 'perplexity');
  });
});
