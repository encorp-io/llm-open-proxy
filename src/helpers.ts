import type { CanonicalChatRequest, ChatMessage } from './types.js';

/**
 * Normalize the legacy `max_tokens` ↔ `max_completion_tokens` aliasing.
 * If both are present, max_completion_tokens wins.
 */
export function resolveMaxCompletionTokens(req: CanonicalChatRequest): number | undefined {
  return req.max_completion_tokens ?? req.max_tokens;
}

/** Default max_tokens used when Anthropic-style providers require the field but caller omitted it. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

/** Anthropic reasoning_effort → thinking.budget_tokens mapping. */
export const ANTHROPIC_THINKING_BUDGET: Record<
  NonNullable<CanonicalChatRequest['reasoning_effort']>,
  number
> = {
  minimal: 1024,
  low: 4096,
  medium: 16384,
  high: 32768,
};

/** Strip `reasoning_content` from assistant messages (used for non-DeepSeek providers). */
export function stripReasoningContent(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== 'assistant' || m.reasoning_content === undefined) return m;
    const { reasoning_content, ...rest } = m;
    void reasoning_content;
    return rest;
  });
}

/**
 * Extract leading system messages (concatenated with \n\n) and return the
 * remaining messages. Mid-thread system messages are inlined as user content
 * (with a warning) because Anthropic disallows system messages mid-conversation.
 */
export function extractSystemMessages(
  messages: ChatMessage[],
  warn: (msg: string) => void,
): { system: string | undefined; messages: ChatMessage[] } {
  const systemTexts: string[] = [];
  const out: ChatMessage[] = [];
  let leading = true;

  for (const m of messages) {
    if (m.role === 'system') {
      const text =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
                .map((p) => p.text)
                .join('')
            : '';
      if (leading) {
        systemTexts.push(text);
      } else {
        warn('mid-thread system message inlined as user content (provider disallows mid-thread system)');
        out.push({ role: 'user', content: text });
      }
    } else {
      leading = false;
      out.push(m);
    }
  }

  return {
    system: systemTexts.length > 0 ? systemTexts.join('\n\n') : undefined,
    messages: out,
  };
}

/** Clamp temperature to a maximum value, recording a warning if clamped. */
export function clampTemperature(value: number, max: number, warn: (msg: string) => void): number {
  if (value > max) {
    warn(`temperature ${value} clamped to ${max}`);
    return max;
  }
  return value;
}

/** True if the model id starts with any of the prefixes (case-insensitive). */
export function modelMatches(modelId: string, prefixes: readonly string[]): boolean {
  const lower = modelId.toLowerCase();
  return prefixes.some((p) => lower.startsWith(p.toLowerCase()));
}
