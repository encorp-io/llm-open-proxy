/**
 * Provider-config resolver.
 *
 * Maps a `ProviderName` to its `ProviderParamConfig` and to the engine's
 * canonical provider key. xAI and Kimi speak OpenAI's shape natively, so
 * they reuse the OpenAI config (with their own base URLs at the transport
 * layer).
 */

import type { ProviderName } from '../types.js';
import type { ProviderParamConfig } from '../engine.js';
import { openaiChatConfig } from './openai.js';
import { googleChatConfig } from './google.js';
import { anthropicChatConfig } from './anthropic.js';
import { deepseekChatConfig } from './deepseek.js';
import { perplexityChatConfig } from './perplexity.js';

export interface ProviderConfigResolution {
  config: ProviderParamConfig;
  /** The canonical provider key used by the mapping engine (xai/kimi fold into 'openai'). */
  canonicalProvider: ProviderName;
}

export function getProviderConfig(provider: ProviderName): ProviderConfigResolution {
  switch (provider) {
    case 'openai':
    case 'xai':
    case 'kimi':
      return { config: openaiChatConfig, canonicalProvider: 'openai' };
    case 'google':
      return { config: googleChatConfig, canonicalProvider: 'google' };
    case 'anthropic':
      return { config: anthropicChatConfig, canonicalProvider: 'anthropic' };
    case 'deepseek':
      return { config: deepseekChatConfig, canonicalProvider: 'deepseek' };
    case 'perplexity':
      return { config: perplexityChatConfig, canonicalProvider: 'perplexity' };
  }
}

export {
  openaiChatConfig,
  googleChatConfig,
  anthropicChatConfig,
  deepseekChatConfig,
  perplexityChatConfig,
};
