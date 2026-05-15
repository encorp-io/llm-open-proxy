import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  resolveMaxCompletionTokens,
  stripReasoningContent,
  extractSystemMessages,
  clampTemperature,
  modelMatches,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_THINKING_BUDGET,
} from '../src/helpers.js';
import type { CanonicalChatRequest, ChatMessage } from '../src/types.js';

const baseReq: CanonicalChatRequest = {
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('resolveMaxCompletionTokens', () => {
  it('prefers max_completion_tokens over max_tokens', () => {
    assert.equal(
      resolveMaxCompletionTokens({ ...baseReq, max_completion_tokens: 100, max_tokens: 50 }),
      100,
    );
  });

  it('falls back to max_tokens when max_completion_tokens is absent', () => {
    assert.equal(resolveMaxCompletionTokens({ ...baseReq, max_tokens: 50 }), 50);
  });

  it('returns undefined when neither is set', () => {
    assert.equal(resolveMaxCompletionTokens(baseReq), undefined);
  });
});

describe('stripReasoningContent', () => {
  it('removes reasoning_content from assistant messages', () => {
    const out = stripReasoningContent([
      { role: 'assistant', content: 'hi', reasoning_content: 'thinking...' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].content, 'hi');
    assert.equal((out[0] as ChatMessage).reasoning_content, undefined);
  });

  it('leaves assistant messages without reasoning_content untouched', () => {
    const msg: ChatMessage = { role: 'assistant', content: 'hi' };
    const out = stripReasoningContent([msg]);
    assert.equal(out[0], msg);
  });

  it('leaves non-assistant messages untouched even if reasoning_content slipped in', () => {
    const msg: ChatMessage = { role: 'user', content: 'hi' };
    const out = stripReasoningContent([msg]);
    assert.equal(out[0], msg);
  });
});

describe('extractSystemMessages', () => {
  it('joins multiple leading system messages with double newline', () => {
    const warns: string[] = [];
    const { system, messages } = extractSystemMessages(
      [
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'user', content: 'hi' },
      ],
      (w) => warns.push(w),
    );
    assert.equal(system, 'A\n\nB');
    assert.equal(messages.length, 1);
    assert.equal(warns.length, 0);
  });

  it('inlines mid-thread system messages as user messages with a warning', () => {
    const warns: string[] = [];
    const { system, messages } = extractSystemMessages(
      [
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'mid' },
      ],
      (w) => warns.push(w),
    );
    assert.equal(system, undefined);
    assert.equal(messages.length, 2);
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[1].content, 'mid');
    assert.equal(warns.length, 1);
    assert.match(warns[0], /mid-thread/);
  });

  it('handles array content with text parts only', () => {
    const { system } = extractSystemMessages(
      [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'one ' },
            { type: 'image_url', image_url: { url: 'x' } },
            { type: 'text', text: 'two' },
          ],
        },
        { role: 'user', content: 'hi' },
      ],
      () => {},
    );
    assert.equal(system, 'one two');
  });

  it('treats null content as empty string', () => {
    const { system } = extractSystemMessages(
      [
        { role: 'system', content: null },
        { role: 'user', content: 'hi' },
      ],
      () => {},
    );
    assert.equal(system, '');
  });

  it('returns undefined when there are no system messages', () => {
    const { system } = extractSystemMessages(
      [{ role: 'user', content: 'hi' }],
      () => {},
    );
    assert.equal(system, undefined);
  });
});

describe('clampTemperature', () => {
  it('clamps and warns when above max', () => {
    const warns: string[] = [];
    const out = clampTemperature(1.5, 1.0, (w) => warns.push(w));
    assert.equal(out, 1.0);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /clamped/);
  });

  it('passes through when at or below max', () => {
    const warns: string[] = [];
    assert.equal(clampTemperature(1.0, 1.0, (w) => warns.push(w)), 1.0);
    assert.equal(clampTemperature(0.5, 1.0, (w) => warns.push(w)), 0.5);
    assert.equal(warns.length, 0);
  });
});

describe('modelMatches', () => {
  it('matches a single prefix case-insensitively', () => {
    assert.equal(modelMatches('GPT-5-turbo', ['gpt-5']), true);
  });

  it('matches when any of multiple prefixes hits', () => {
    assert.equal(modelMatches('o3-mini', ['gpt-5', 'o3', 'o4']), true);
  });

  it('returns false when no prefix matches', () => {
    assert.equal(modelMatches('claude-opus', ['gpt-5', 'o3']), false);
  });

  it('returns false on empty prefix list', () => {
    assert.equal(modelMatches('anything', []), false);
  });
});

describe('module constants', () => {
  it('exposes Anthropic default max_tokens', () => {
    assert.equal(ANTHROPIC_DEFAULT_MAX_TOKENS, 4096);
  });

  it('exposes Anthropic thinking-budget table', () => {
    assert.equal(ANTHROPIC_THINKING_BUDGET.minimal, 1024);
    assert.equal(ANTHROPIC_THINKING_BUDGET.low, 4096);
    assert.equal(ANTHROPIC_THINKING_BUDGET.medium, 16384);
    assert.equal(ANTHROPIC_THINKING_BUDGET.high, 32768);
  });
});
