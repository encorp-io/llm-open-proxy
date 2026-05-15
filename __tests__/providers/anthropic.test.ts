import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { transformChatRequest } from '../../src/engine.js';
import {
  anthropicChatConfig,
  toAnthropicRequest,
  toCanonicalResponse,
  sendAnthropicRequest,
  streamAnthropicRequest,
  type AnthropicRequest,
} from '../../src/providers/anthropic.js';
import { UpstreamError } from '../../src/errors.js';
import type { CanonicalChatRequest } from '../../src/types.js';

const base: CanonicalChatRequest = {
  model: 'claude-opus-4-6',
  messages: [{ role: 'user', content: 'hi' }],
};

// ---------------------------------------------------------------------------
// Config — declarative scalar mapping
// ---------------------------------------------------------------------------

describe('anthropicChatConfig — scalar mapping', () => {
  it('clamps temperature above 1 with warning', () => {
    const { body, warnings } = transformChatRequest(
      { ...base, temperature: 1.5 },
      anthropicChatConfig,
      'anthropic',
    );
    assert.equal(body.temperature, 1.0);
    assert.ok(warnings.some((w) => /clamped/.test(w)));
  });

  it('passes temperature unchanged when at or below 1', () => {
    const { body, warnings } = transformChatRequest(
      { ...base, temperature: 0.5 },
      anthropicChatConfig,
      'anthropic',
    );
    assert.equal(body.temperature, 0.5);
    assert.equal(warnings.length, 1); // max_tokens default warning fires
    assert.match(warnings[0], /max_tokens/);
  });

  it('passes top_p and top_k through', () => {
    const { body } = transformChatRequest(
      { ...base, top_p: 0.9, top_k: 40 },
      anthropicChatConfig,
      'anthropic',
    );
    assert.equal(body.top_p, 0.9);
    assert.equal(body.top_k, 40);
  });

  it('renames stop → stop_sequences', () => {
    const { body } = transformChatRequest(
      { ...base, stop: ['END'] },
      anthropicChatConfig,
      'anthropic',
    );
    assert.deepEqual(body.stop_sequences, ['END']);
  });

  it('renames max_completion_tokens → max_tokens', () => {
    const { body } = transformChatRequest(
      { ...base, max_completion_tokens: 256 },
      anthropicChatConfig,
      'anthropic',
    );
    assert.equal(body.max_tokens, 256);
  });

  it('uses legacy max_tokens when only that is provided', () => {
    const { body } = transformChatRequest(
      { ...base, max_tokens: 128 },
      anthropicChatConfig,
      'anthropic',
    );
    assert.equal(body.max_tokens, 128);
  });

  it('defaults max_tokens to 4096 with a warning when neither field is provided', () => {
    const { body, warnings } = transformChatRequest(base, anthropicChatConfig, 'anthropic');
    assert.equal(body.max_tokens, 4096);
    assert.ok(warnings.some((w) => /max_tokens missing/.test(w)));
  });

  it('drops n, frequency_penalty, presence_penalty, logit_bias, seed, logprobs, top_logprobs, parallel_tool_calls, response_format, tools, tool_choice, stream_options', () => {
    const { warnings } = transformChatRequest(
      {
        ...base,
        n: 2,
        frequency_penalty: 0.1,
        presence_penalty: 0.1,
        logit_bias: { x: 1 },
        seed: 5,
        logprobs: true,
        top_logprobs: 3,
        parallel_tool_calls: true,
        response_format: { type: 'json_object' },
        tools: [{ type: 'function', function: { name: 'x' } }],
        tool_choice: 'auto',
        stream_options: { include_usage: true },
      },
      anthropicChatConfig,
      'anthropic',
    );
    for (const f of [
      'n',
      'frequency_penalty',
      'presence_penalty',
      'logit_bias',
      'seed',
      'logprobs',
      'top_logprobs',
      'parallel_tool_calls',
      'response_format',
      'tools',
      'tool_choice',
      'stream_options',
    ]) {
      assert.ok(
        warnings.some((w) => w.includes(`'${f}' dropped for anthropic`)),
        `expected warning for ${f}`,
      );
    }
  });

  it('routes user → metadata.user_id', () => {
    const { body } = transformChatRequest(
      { ...base, user: 'u-1' },
      anthropicChatConfig,
      'anthropic',
    );
    assert.deepEqual(body.metadata, { user_id: 'u-1' });
  });

  it('preserves an existing metadata object when the user-action runs', () => {
    // Exercise the `body.metadata ?? {}` branch where an existing metadata
    // object is already on the body before the user action fires.
    const action = anthropicChatConfig.user!;
    assert.equal(action.kind, 'custom');
    const body: Record<string, unknown> = { metadata: { keep: 'me' } };
    if (action.kind === 'custom') {
      action.apply(body, 'u-1', {
        provider: 'anthropic',
        fullRequest: base,
        warn: () => {},
      });
    }
    assert.deepEqual(body.metadata, { keep: 'me', user_id: 'u-1' });
  });

  for (const [effort, budget] of [
    ['minimal', 1024],
    ['low', 4096],
    ['medium', 16384],
    ['high', 32768],
  ] as const) {
    it(`maps reasoning_effort=${effort} to thinking budget ${budget}`, () => {
      const { body } = transformChatRequest(
        { ...base, reasoning_effort: effort },
        anthropicChatConfig,
        'anthropic',
      );
      assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: budget });
    });
  }

  it('falls back to medium budget when reasoning_effort is unrecognised', () => {
    const { body } = transformChatRequest(
      { ...base, reasoning_effort: 'bogus' as never },
      anthropicChatConfig,
      'anthropic',
    );
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 16384 });
  });

  it('passes through stream', () => {
    const { body } = transformChatRequest(
      { ...base, stream: true },
      anthropicChatConfig,
      'anthropic',
    );
    assert.equal(body.stream, true);
  });
});

// ---------------------------------------------------------------------------
// Request translation: canonical → Anthropic
// ---------------------------------------------------------------------------

describe('toAnthropicRequest — message reshape', () => {
  it('extracts a leading system message and concatenates multiple', () => {
    const { request } = toAnthropicRequest({
      ...base,
      messages: [
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'user', content: 'hi' },
      ],
    });
    assert.equal(request.system, 'A\n\nB');
    assert.equal(request.messages.length, 1);
    assert.deepEqual(request.messages[0], { role: 'user', content: 'hi' });
  });

  it('handles a system message with array content (text parts only)', () => {
    const { request } = toAnthropicRequest({
      ...base,
      messages: [
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
    });
    assert.equal(request.system, 'one two');
  });

  it('omits the system field when the only system message is empty', () => {
    // Empty / null system content collapses; the spread guard
    // `(systemPrompt ? { system } : {})` excludes the field on falsy values.
    const { request } = toAnthropicRequest({
      ...base,
      messages: [
        { role: 'system', content: null },
        { role: 'user', content: 'hi' },
      ],
    });
    assert.equal(request.system, undefined);
  });

  it('translates assistant tool_calls into tool_use content blocks', () => {
    const { request } = toAnthropicRequest({
      ...base,
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: 'Looking up',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'wx', arguments: '{"city":"Sofia"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
      ],
    });
    const assistantMsg = request.messages[1];
    const blocks = assistantMsg.content as Array<{ type: string }>;
    assert.equal(blocks[0].type, 'text');
    assert.equal(blocks[1].type, 'tool_use');
  });

  it('omits assistant text block when content is empty string', () => {
    const { request } = toAnthropicRequest({
      ...base,
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'c', type: 'function', function: { name: 'x', arguments: '{}' } },
          ],
        },
      ],
    });
    const blocks = request.messages[0].content as Array<{ type: string }>;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'tool_use');
  });

  it('handles assistant tool_calls with empty arguments string', () => {
    const { request } = toAnthropicRequest({
      ...base,
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '' } }],
        },
      ],
    });
    const blocks = request.messages[0].content as Array<{ type: string; input?: unknown }>;
    assert.deepEqual(blocks[0].input, {});
  });

  it('flushes pending tool_results when the next message is not a tool', () => {
    const { request } = toAnthropicRequest({
      ...base,
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'result' },
        { role: 'user', content: 'next question' },
      ],
    });
    assert.equal(request.messages.length, 3);
    const flushed = request.messages[1];
    assert.equal(flushed.role, 'user');
    const blocks = flushed.content as Array<{ type: string }>;
    assert.equal(blocks[0].type, 'tool_result');
  });

  it('JSON-stringifies a tool message with non-string content', () => {
    const { request } = toAnthropicRequest({
      ...base,
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'c',
          content: [{ type: 'text', text: 'literal' }],
        },
      ],
    });
    const userMsg = request.messages[1];
    const blocks = userMsg.content as Array<{ type: string; content: string }>;
    assert.match(blocks[0].content, /literal/);
  });

  it('uses empty tool_use_id when tool message lacks tool_call_id', () => {
    const { request } = toAnthropicRequest({
      ...base,
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{}' } }],
        },
        { role: 'tool', content: 'r' },
      ],
    });
    const userMsg = request.messages[1];
    const blocks = userMsg.content as Array<{ tool_use_id: string }>;
    assert.equal(blocks[0].tool_use_id, '');
  });

  it('translates image_url with data URI to base64 image block', () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
    const { request } = toAnthropicRequest({
      ...base,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see' },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
        },
      ],
    });
    const blocks = request.messages[0].content as Array<{ type: string; source?: { type: string; media_type?: string; data?: string; url?: string } }>;
    assert.equal(blocks[1].type, 'image');
    assert.equal(blocks[1].source!.type, 'base64');
    assert.equal(blocks[1].source!.media_type, 'image/png');
    assert.equal(blocks[1].source!.data, 'iVBORw0KGgo=');
  });

  it('translates image_url with regular URL to URL image block', () => {
    const { request } = toAnthropicRequest({
      ...base,
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }],
        },
      ],
    });
    const blocks = request.messages[0].content as Array<{ source?: { type: string; url?: string } }>;
    assert.equal(blocks[0].source!.type, 'url');
    assert.equal(blocks[0].source!.url, 'https://x/y.png');
  });

  it('strips reasoning_content from assistant messages before sending', () => {
    const { request } = toAnthropicRequest({
      ...base,
      messages: [
        {
          role: 'assistant',
          content: 'thought through',
          reasoning_content: 'leak',
        },
      ],
    });
    // Anthropic message shape doesn't carry reasoning_content
    assert.equal((request.messages[0] as { reasoning_content?: string }).reasoning_content, undefined);
  });

  it('treats unrecognised role values as user (defensive)', () => {
    const { request } = toAnthropicRequest({
      ...base,
      messages: [
        // 'developer' is allowed in the canonical Role union but not in Anthropic
        { role: 'developer', content: 'hello' },
      ],
    });
    assert.equal(request.messages[0].role, 'user');
  });

  it('coerces non-string non-array content to empty string in the default branch', () => {
    const { request } = toAnthropicRequest({
      ...base,
      messages: [{ role: 'user', content: null }],
    });
    assert.equal(request.messages[0].content, '');
  });
});

describe('toAnthropicRequest — tools / tool_choice / response_format', () => {
  it('reshapes tools into Anthropic input_schema format', () => {
    const { request } = toAnthropicRequest({
      ...base,
      tools: [
        {
          type: 'function',
          function: {
            name: 'wx',
            description: 'weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
    });
    assert.equal(request.tools![0].name, 'wx');
    assert.equal(request.tools![0].description, 'weather');
    assert.deepEqual(request.tools![0].input_schema, {
      type: 'object',
      properties: { city: { type: 'string' } },
    });
  });

  it('falls back to a default object schema when parameters are absent', () => {
    const { request } = toAnthropicRequest({
      ...base,
      tools: [{ type: 'function', function: { name: 'noop' } }],
    });
    assert.deepEqual(request.tools![0].input_schema, { type: 'object', properties: {} });
  });

  it('translates tool_choice="auto" → {type:"auto"}', () => {
    const { request } = toAnthropicRequest({ ...base, tool_choice: 'auto' });
    assert.deepEqual(request.tool_choice, { type: 'auto' });
  });

  it('translates tool_choice="none" by removing tools (Anthropic has no none)', () => {
    const { request } = toAnthropicRequest({
      ...base,
      tools: [{ type: 'function', function: { name: 'x' } }],
      tool_choice: 'none',
    });
    assert.equal(request.tools, undefined);
    assert.equal(request.tool_choice, undefined);
  });

  it('translates tool_choice="required" → {type:"any"}', () => {
    const { request } = toAnthropicRequest({ ...base, tool_choice: 'required' });
    assert.deepEqual(request.tool_choice, { type: 'any' });
  });

  it('translates tool_choice for a specific function to {type:"tool",name}', () => {
    const { request } = toAnthropicRequest({
      ...base,
      tool_choice: { type: 'function', function: { name: 'wx' } },
    });
    assert.deepEqual(request.tool_choice, { type: 'tool', name: 'wx' });
  });

  it('ignores object tool_choice with empty function name', () => {
    const { request } = toAnthropicRequest({
      ...base,
      tool_choice: { type: 'function', function: { name: '' } },
    });
    assert.equal(request.tool_choice, undefined);
  });

  it('translates response_format=json_object → output_config with object schema', () => {
    const { request } = toAnthropicRequest({
      ...base,
      response_format: { type: 'json_object' },
    });
    assert.deepEqual(request.output_config, {
      format: { type: 'json_schema', schema: { type: 'object' } },
    });
  });

  it('translates response_format=json_schema → output_config with the supplied schema', () => {
    const schema = { type: 'object', properties: { a: { type: 'number' } } };
    const { request } = toAnthropicRequest({
      ...base,
      response_format: { type: 'json_schema', json_schema: { name: 'X', schema } },
    });
    assert.equal(request.output_config!.format.type, 'json_schema');
    assert.deepEqual(request.output_config!.format.schema, schema);
  });

  it('does not set output_config for response_format=text', () => {
    const { request } = toAnthropicRequest({
      ...base,
      response_format: { type: 'text' },
    });
    assert.equal(request.output_config, undefined);
  });
});

// ---------------------------------------------------------------------------
// Response translation: Anthropic → canonical
// ---------------------------------------------------------------------------

describe('toCanonicalResponse', () => {
  it('translates a text-only response', () => {
    const out = toCanonicalResponse(
      {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
        model: 'claude-opus',
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 3 },
      },
      'claude-opus-4-6',
    );
    assert.equal(out.id, 'chatcmpl-msg_1');
    assert.equal(out.choices[0].message.content, 'Hello!');
    assert.equal(out.choices[0].finish_reason, 'stop');
    assert.deepEqual(out.usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
  });

  it('emits null content when there is no text block', () => {
    const out = toCanonicalResponse(
      {
        id: 'm',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'x', input: { y: 1 } }],
        model: 'claude-opus',
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      'claude-opus-4-6',
    );
    assert.equal(out.choices[0].message.content, null);
    assert.equal(out.choices[0].finish_reason, 'tool_calls');
    assert.equal(out.choices[0].message.tool_calls!.length, 1);
    assert.deepEqual(JSON.parse(out.choices[0].message.tool_calls![0].function.arguments), {
      y: 1,
    });
  });

  it('combines text and tool_use blocks in one choice', () => {
    const out = toCanonicalResponse(
      {
        id: 'm',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Calling…' },
          { type: 'tool_use', id: 't1', name: 'wx', input: {} },
        ],
        model: 'claude-opus',
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      'claude-opus-4-6',
    );
    assert.equal(out.choices[0].message.content, 'Calling…');
    assert.equal(out.choices[0].message.tool_calls!.length, 1);
  });

  it('defaults id, name and input on tool_use blocks missing those fields', () => {
    const out = toCanonicalResponse(
      {
        id: 'm',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'tool_use' }],
        model: 'claude',
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      'claude',
    );
    const tc = out.choices[0].message.tool_calls![0];
    assert.equal(tc.id, '');
    assert.equal(tc.function.name, '');
    assert.equal(tc.function.arguments, '{}');
  });

  it('defaults missing text in a text block to empty string', () => {
    const out = toCanonicalResponse(
      {
        id: 'm',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text' }],
        model: 'claude',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 0 },
      },
      'claude',
    );
    assert.equal(out.choices[0].message.content, null);
  });

  for (const [reason, mapped] of [
    ['end_turn', 'stop'],
    ['max_tokens', 'length'],
    ['stop_sequence', 'stop'],
    ['tool_use', 'tool_calls'],
    ['mystery', 'stop'],
  ] as const) {
    it(`maps stop_reason=${reason} → finish_reason=${mapped}`, () => {
      const out = toCanonicalResponse(
        {
          id: 'm',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'x' }],
          model: 'claude',
          stop_reason: reason,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        'claude',
      );
      assert.equal(out.choices[0].finish_reason, mapped);
    });
  }
});

// ---------------------------------------------------------------------------
// Transport — mock fetch
// ---------------------------------------------------------------------------

interface CapturedCall {
  url: string;
  init: RequestInit;
}

const calls: CapturedCall[] = [];
const originalFetch = globalThis.fetch;

function installFetchMock(impl: (url: string, init: RequestInit) => Promise<Response>) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    return impl(url, init ?? {});
  }) as typeof fetch;
}

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('sendAnthropicRequest', () => {
  it('translates request and response in a single call', async () => {
    installFetchMock(async () =>
      jsonResponse({
        id: 'msg_x',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi.' }],
        model: 'claude-opus-4-6',
        stop_reason: 'end_turn',
        usage: { input_tokens: 4, output_tokens: 2 },
      }),
    );

    const { response, usage, warnings } = await sendAnthropicRequest({
      apiKey: 'sk-a',
      body: base,
    });

    assert.equal(calls.length, 1);
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], 'sk-a');
    assert.equal(headers['anthropic-version'], '2023-06-01');
    const payload = JSON.parse(calls[0].init.body as string) as AnthropicRequest;
    assert.equal(payload.stream, false);
    assert.equal(payload.max_tokens, 4096);

    assert.equal(response.choices[0].message.content, 'Hi.');
    assert.deepEqual(usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
    assert.ok(warnings.some((w) => /max_tokens missing/.test(w)));
  });

  it('uses a custom baseUrl and apiVersion', async () => {
    installFetchMock(async () =>
      jsonResponse({
        id: 'm',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        model: 'claude',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 0 },
      }),
    );
    await sendAnthropicRequest({
      apiKey: 'k',
      body: base,
      baseUrl: 'https://proxy.example.com/v1/messages',
      apiVersion: '2099-01-01',
    });
    assert.equal(calls[0].url, 'https://proxy.example.com/v1/messages');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['anthropic-version'], '2099-01-01');
  });

  it('throws UpstreamError with message from upstream error body', async () => {
    installFetchMock(async () => jsonResponse({ error: { message: 'overloaded' } }, 529));
    await assert.rejects(
      sendAnthropicRequest({ apiKey: 'k', body: base }),
      (err: unknown) =>
        err instanceof UpstreamError && err.statusCode === 529 && err.message === 'overloaded',
    );
  });

  it('throws UpstreamError with default message when body is unparseable', async () => {
    installFetchMock(
      async () => new Response('plain', { status: 500, headers: { 'Content-Type': 'text/plain' } }),
    );
    await assert.rejects(
      sendAnthropicRequest({ apiKey: 'k', body: base }),
      (err: unknown) =>
        err instanceof UpstreamError && err.statusCode === 500 && /Anthropic API error 500/.test(err.message),
    );
  });

  it('throws UpstreamError(504) on timeout', async () => {
    installFetchMock(async () => {
      throw new DOMException('timeout', 'TimeoutError');
    });
    await assert.rejects(
      sendAnthropicRequest({ apiKey: 'k', body: base, timeoutMs: 5 }),
      (err: unknown) => err instanceof UpstreamError && err.statusCode === 504,
    );
  });

  it('rethrows non-timeout fetch errors', async () => {
    installFetchMock(async () => {
      throw new Error('dns');
    });
    await assert.rejects(sendAnthropicRequest({ apiKey: 'k', body: base }), /dns/);
  });

  it('forwards an external AbortSignal', async () => {
    const ac = new AbortController();
    installFetchMock(async (_u, init) => {
      assert.ok(init.signal, 'signal forwarded');
      return jsonResponse({
        id: 'm',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        model: 'claude',
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    });
    await sendAnthropicRequest({ apiKey: 'k', body: base, signal: ac.signal });
  });
});

// ---------------------------------------------------------------------------
// Streaming — Anthropic SSE → OpenAI SSE
// ---------------------------------------------------------------------------

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function readAllText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  out += dec.decode();
  return out;
}

describe('streamAnthropicRequest — happy path', () => {
  it('translates message_start, content_block_delta text, message_delta into OpenAI chunks', async () => {
    installFetchMock(async () =>
      new Response(
        sseStream([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n',
          'data: {"type":"content_block_delta","delta":{"text":"Hi"}}\n\n',
          'data: {"type":"content_block_delta","delta":{"text":"!"}}\n\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
        ]),
        { status: 200 },
      ),
    );
    const { stream, getUsage, warnings } = await streamAnthropicRequest({
      apiKey: 'k',
      body: base,
    });
    const text = await readAllText(stream);
    assert.match(text, /"content":"Hi"/);
    assert.match(text, /"content":"!"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /\[DONE\]/);
    assert.deepEqual(getUsage(), { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
    assert.ok(Array.isArray(warnings));
  });

  it('translates content_block_start tool_use and input_json_delta into tool_calls chunks', async () => {
    installFetchMock(async () =>
      new Response(
        sseStream([
          'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"t1","name":"wx"}}\n\n',
          'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n\n',
          'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"\\"Sofia\\"}"}}\n\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
        ]),
        { status: 200 },
      ),
    );
    const { stream } = await streamAnthropicRequest({ apiKey: 'k', body: base });
    const text = await readAllText(stream);
    assert.match(text, /"tool_calls"/);
    assert.match(text, /"name":"wx"/);
    assert.match(text, /"finish_reason":"tool_calls"/);
  });

  it('handles a missing partial_json by emitting empty arguments', async () => {
    installFetchMock(async () =>
      new Response(
        sseStream([
          'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"t1","name":"x"}}\n\n',
          'data: {"type":"content_block_delta","delta":{"type":"input_json_delta"}}\n\n',
          'data: {"type":"message_delta","delta":{}}\n\n',
        ]),
        { status: 200 },
      ),
    );
    const { stream } = await streamAnthropicRequest({ apiKey: 'k', body: base });
    const text = await readAllText(stream);
    assert.match(text, /"arguments":""/);
  });

  it('emits finish_reason=stop when message_delta has no stop_reason', async () => {
    installFetchMock(async () =>
      new Response(sseStream(['data: {"type":"message_delta","delta":{}}\n\n']), { status: 200 }),
    );
    const { stream } = await streamAnthropicRequest({ apiKey: 'k', body: base });
    const text = await readAllText(stream);
    assert.match(text, /"finish_reason":"stop"/);
  });

  it('ignores non-data lines and unparseable JSON', async () => {
    installFetchMock(async () =>
      new Response(
        sseStream([
          ': comment\n\n',
          'data: not-json\n\n',
          'data: \n',
          'data: [DONE]\n',
          'data: {"type":"message_delta","delta":{}}\n\n',
        ]),
        { status: 200 },
      ),
    );
    const { stream, getUsage } = await streamAnthropicRequest({ apiKey: 'k', body: base });
    const text = await readAllText(stream);
    assert.match(text, /\[DONE\]/);
    assert.equal(getUsage().completion_tokens, 0);
  });

  it('handles message events with missing or partial usage data', async () => {
    installFetchMock(async () =>
      new Response(
        sseStream([
          'data: {"type":"message_start","message":{}}\n\n',
          'data: {"type":"message_start","message":{"usage":{}}}\n\n',
          'data: {"type":"message_delta","delta":{},"usage":{}}\n\n',
        ]),
        { status: 200 },
      ),
    );
    const { stream, getUsage } = await streamAnthropicRequest({ apiKey: 'k', body: base });
    await readAllText(stream);
    assert.deepEqual(getUsage(), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it('forces stream:true on the upstream request', async () => {
    installFetchMock(async (_u, init) => {
      const payload = JSON.parse(init.body as string);
      assert.equal(payload.stream, true);
      return new Response(sseStream([]), { status: 200 });
    });
    const { stream } = await streamAnthropicRequest({ apiKey: 'k', body: base });
    await readAllText(stream);
  });
});

describe('streamAnthropicRequest — error paths', () => {
  it('throws UpstreamError on non-2xx response', async () => {
    installFetchMock(async () => jsonResponse({ error: { message: 'denied' } }, 401));
    await assert.rejects(
      streamAnthropicRequest({ apiKey: 'k', body: base }),
      (err: unknown) =>
        err instanceof UpstreamError && err.statusCode === 401 && err.message === 'denied',
    );
  });

  it('throws UpstreamError with default message on unparseable error body', async () => {
    installFetchMock(
      async () => new Response('plain', { status: 502, headers: { 'Content-Type': 'text/plain' } }),
    );
    await assert.rejects(
      streamAnthropicRequest({ apiKey: 'k', body: base }),
      (err: unknown) =>
        err instanceof UpstreamError && err.statusCode === 502 && /Anthropic API error 502/.test(err.message),
    );
  });

  it('throws UpstreamError(502) when the response has no body', async () => {
    installFetchMock(async () => new Response(null, { status: 200 }));
    await assert.rejects(
      streamAnthropicRequest({ apiKey: 'k', body: base }),
      (err: unknown) =>
        err instanceof UpstreamError && err.statusCode === 502 && /No response body/.test(err.message),
    );
  });

  it('throws UpstreamError(504) on timeout during streaming open', async () => {
    installFetchMock(async () => {
      throw new DOMException('timeout', 'TimeoutError');
    });
    await assert.rejects(
      streamAnthropicRequest({ apiKey: 'k', body: base, timeoutMs: 5 }),
      (err: unknown) => err instanceof UpstreamError && err.statusCode === 504,
    );
  });

  it('rethrows non-timeout fetch errors', async () => {
    installFetchMock(async () => {
      throw new Error('reset');
    });
    await assert.rejects(streamAnthropicRequest({ apiKey: 'k', body: base }), /reset/);
  });

  it('propagates errors raised mid-stream into the consumer', async () => {
    installFetchMock(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"type":"message_start"}\n\n'));
              controller.error(new Error('mid-stream boom'));
            },
          }),
          { status: 200 },
        ),
    );
    const { stream } = await streamAnthropicRequest({ apiKey: 'k', body: base });
    await assert.rejects(readAllText(stream), /mid-stream boom/);
  });
});
