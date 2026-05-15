import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { transformChatRequest } from '../../src/engine.js';
import {
  openaiChatConfig,
  sendChatRequest,
  streamChatRequest,
  OPENAI_API_URL,
  GOOGLE_OPENAI_COMPAT_URL,
  XAI_API_URL,
  DEEPSEEK_API_URL,
  KIMI_API_URL,
  PERPLEXITY_API_URL,
} from '../../src/providers/openai.js';
import { UpstreamError } from '../../src/errors.js';
import type { CanonicalChatRequest } from '../../src/types.js';

const base: CanonicalChatRequest = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
};

/** Cast helper — transport accepts a fully-converted (Record-shaped) body. */
const asBody = (b: object): Record<string, unknown> => b as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Config tests
// ---------------------------------------------------------------------------

describe('openaiChatConfig — sampling-locked models', () => {
  for (const model of ['gpt-5', 'GPT-5-turbo', 'o1', 'o3-mini', 'o4-pro']) {
    it(`drops temperature with warning on ${model}`, () => {
      const { body, warnings } = transformChatRequest(
        { ...base, model, temperature: 0.5 },
        openaiChatConfig,
        'openai',
      );
      assert.equal(body.temperature, undefined);
      assert.ok(warnings.some((w) => w.includes('temperature unsupported')));
    });

    it(`drops top_p with warning on ${model}`, () => {
      const { body, warnings } = transformChatRequest(
        { ...base, model, top_p: 0.9 },
        openaiChatConfig,
        'openai',
      );
      assert.equal(body.top_p, undefined);
      assert.ok(warnings.some((w) => w.includes('top_p unsupported')));
    });
  }

  it('keeps temperature/top_p on regular models', () => {
    const { body, warnings } = transformChatRequest(
      { ...base, temperature: 0.7, top_p: 0.95 },
      openaiChatConfig,
      'openai',
    );
    assert.equal(body.temperature, 0.7);
    assert.equal(body.top_p, 0.95);
    assert.deepEqual(warnings, []);
  });
});

describe('openaiChatConfig — passthroughs and resolution', () => {
  it('passes through max_completion_tokens directly', () => {
    const { body } = transformChatRequest(
      { ...base, max_completion_tokens: 200 },
      openaiChatConfig,
      'openai',
    );
    assert.equal(body.max_completion_tokens, 200);
  });

  it('translates legacy max_tokens to max_completion_tokens', () => {
    const { body } = transformChatRequest(
      { ...base, max_tokens: 150 },
      openaiChatConfig,
      'openai',
    );
    assert.equal(body.max_completion_tokens, 150);
  });

  it('omits max_completion_tokens when neither field is set', () => {
    const { body } = transformChatRequest(base, openaiChatConfig, 'openai');
    assert.equal(body.max_completion_tokens, undefined);
  });

  it('drops top_k with a warning', () => {
    const { warnings } = transformChatRequest(
      { ...base, top_k: 40 },
      openaiChatConfig,
      'openai',
    );
    assert.ok(warnings.some((w) => w.includes('top_k')));
  });

  it('passes through n/stop/penalties/seed/user/logprobs/response_format/tools/tool_choice/parallel_tool_calls/reasoning_effort/stream', () => {
    const { body } = transformChatRequest(
      {
        ...base,
        n: 2,
        stop: ['x'],
        frequency_penalty: 0.1,
        presence_penalty: 0.1,
        logit_bias: { '50256': -1 },
        seed: 7,
        user: 'u',
        logprobs: true,
        top_logprobs: 3,
        response_format: { type: 'json_object' },
        tools: [{ type: 'function', function: { name: 'x' } }],
        tool_choice: 'auto',
        parallel_tool_calls: true,
        reasoning_effort: 'high',
        stream: true,
        stream_options: { include_usage: true },
      },
      openaiChatConfig,
      'openai',
    );
    assert.equal(body.n, 2);
    assert.deepEqual(body.stop, ['x']);
    assert.equal(body.frequency_penalty, 0.1);
    assert.equal(body.presence_penalty, 0.1);
    assert.deepEqual(body.logit_bias, { '50256': -1 });
    assert.equal(body.seed, 7);
    assert.equal(body.user, 'u');
    assert.equal(body.logprobs, true);
    assert.equal(body.top_logprobs, 3);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.ok(Array.isArray(body.tools));
    assert.equal(body.tool_choice, 'auto');
    assert.equal(body.parallel_tool_calls, true);
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
  });
});

// ---------------------------------------------------------------------------
// Transport tests — mock fetch
// ---------------------------------------------------------------------------

interface CapturedCall {
  url: string;
  init: RequestInit;
}

const calls: CapturedCall[] = [];
const originalFetch = globalThis.fetch;
let fetchImpl: (url: string, init: RequestInit) => Promise<Response>;

function installFetchMock(impl: typeof fetchImpl) {
  fetchImpl = impl;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    return fetchImpl(url, init ?? {});
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

describe('sendChatRequest — happy path', () => {
  it('hits the default OpenAI URL with Bearer auth and stream:false', async () => {
    installFetchMock(async () =>
      jsonResponse({
        id: 'x',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o',
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    );

    const result = await sendChatRequest({
      apiKey: 'sk-test',
      body: asBody({ ...base, temperature: 0.5 }),
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, OPENAI_API_URL);
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer sk-test');
    assert.equal(headers['Content-Type'], 'application/json');
    const payload = JSON.parse(calls[0].init.body as string);
    assert.equal(payload.stream, false);
    assert.equal(payload.temperature, 0.5);

    assert.equal(result.response.id, 'x');
    assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
  });

  it('uses a custom baseUrl when provided', async () => {
    installFetchMock(async () =>
      jsonResponse({
        id: 'x',
        object: 'chat.completion',
        created: 1,
        model: 'm',
        choices: [],
      }),
    );
    await sendChatRequest({ apiKey: 'k', body: asBody(base), baseUrl: GOOGLE_OPENAI_COMPAT_URL });
    assert.equal(calls[0].url, GOOGLE_OPENAI_COMPAT_URL);
  });

  it('merges custom headers', async () => {
    installFetchMock(async () =>
      jsonResponse({
        id: 'x',
        object: 'chat.completion',
        created: 1,
        model: 'm',
        choices: [],
      }),
    );
    await sendChatRequest({
      apiKey: 'k',
      body: asBody(base),
      headers: { 'X-Custom': 'yes' },
    });
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['X-Custom'], 'yes');
    assert.equal(headers['Authorization'], 'Bearer k');
  });

  it('defaults usage fields to 0 when missing from response', async () => {
    installFetchMock(async () =>
      jsonResponse({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [] }),
    );
    const r = await sendChatRequest({ apiKey: 'k', body: asBody(base) });
    assert.deepEqual(r.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
});

describe('sendChatRequest — error paths', () => {
  it('throws UpstreamError with message from upstream error body', async () => {
    installFetchMock(async () => jsonResponse({ error: { message: 'rate limited' } }, 429));
    await assert.rejects(
      sendChatRequest({ apiKey: 'k', body: asBody(base) }),
      (err: unknown) =>
        err instanceof UpstreamError && err.statusCode === 429 && err.message === 'rate limited',
    );
  });

  it('throws UpstreamError with default message when error body is unparseable', async () => {
    installFetchMock(
      async () =>
        new Response('not-json', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        }),
    );
    await assert.rejects(
      sendChatRequest({ apiKey: 'k', body: asBody(base) }),
      (err: unknown) =>
        err instanceof UpstreamError && err.statusCode === 500 && /Upstream error 500/.test(err.message),
    );
  });

  it('throws UpstreamError(504) on AbortSignal.timeout', async () => {
    installFetchMock(async () => {
      const e = new DOMException('timeout', 'TimeoutError');
      throw e;
    });
    await assert.rejects(
      sendChatRequest({ apiKey: 'k', body: asBody(base), timeoutMs: 10 }),
      (err: unknown) =>
        err instanceof UpstreamError && err.statusCode === 504 && /timed out/.test(err.message),
    );
  });

  it('rethrows non-timeout fetch errors as-is', async () => {
    installFetchMock(async () => {
      throw new Error('network down');
    });
    await assert.rejects(sendChatRequest({ apiKey: 'k', body: asBody(base) }), /network down/);
  });

  it('combines an external AbortSignal with the timeout signal', async () => {
    const ac = new AbortController();
    installFetchMock(async (_url, init) => {
      assert.ok(init.signal, 'signal forwarded to fetch');
      return jsonResponse({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [] });
    });
    await sendChatRequest({ apiKey: 'k', body: asBody(base), signal: ac.signal });
  });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function readAllText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

describe('streamChatRequest — happy path', () => {
  it('passes the SSE bytes through and captures usage from the final chunk', async () => {
    installFetchMock(async () => {
      const stream = sseStream([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
        '\n',
        'data: {"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
        'data: [DONE]\n\n',
      ]);
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    const { stream, getUsage } = await streamChatRequest({ apiKey: 'k', body: asBody(base) });
    const text = await readAllText(stream);
    assert.match(text, /"hi"/);
    assert.match(text, /\[DONE\]/);
    assert.deepEqual(getUsage(), { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
  });

  it('forces stream:true and stream_options.include_usage in the request body', async () => {
    installFetchMock(async (_url, init) => {
      const payload = JSON.parse(init.body as string);
      assert.equal(payload.stream, true);
      assert.deepEqual(payload.stream_options, { include_usage: true });
      return new Response(sseStream(['data: [DONE]\n\n']), { status: 200 });
    });
    await streamChatRequest({ apiKey: 'k', body: asBody(base) });
  });

  it('ignores partial / unparseable JSON chunks without throwing', async () => {
    installFetchMock(
      async () =>
        new Response(
          sseStream(['data: {"partial', '"choices', 'data: not-json\n', 'data: [DONE]\n\n']),
          { status: 200 },
        ),
    );
    const { stream, getUsage } = await streamChatRequest({ apiKey: 'k', body: asBody(base) });
    await readAllText(stream);
    assert.deepEqual(getUsage(), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it('defaults missing usage fields to 0 when partial usage chunk arrives', async () => {
    installFetchMock(
      async () =>
        new Response(sseStream(['data: {"usage":{}}\n\n', 'data: [DONE]\n\n']), { status: 200 }),
    );
    const { stream, getUsage } = await streamChatRequest({ apiKey: 'k', body: asBody(base) });
    await readAllText(stream);
    assert.deepEqual(getUsage(), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
});

describe('streamChatRequest — error paths', () => {
  it('throws UpstreamError on non-2xx status', async () => {
    installFetchMock(async () => jsonResponse({ error: { message: 'forbidden' } }, 403));
    await assert.rejects(
      streamChatRequest({ apiKey: 'k', body: asBody(base) }),
      (err: unknown) =>
        err instanceof UpstreamError && err.statusCode === 403 && err.message === 'forbidden',
    );
  });

  it('throws UpstreamError with default message on non-2xx with unparseable body', async () => {
    installFetchMock(
      async () =>
        new Response('plain', { status: 502, headers: { 'Content-Type': 'text/plain' } }),
    );
    await assert.rejects(
      streamChatRequest({ apiKey: 'k', body: asBody(base) }),
      (err: unknown) =>
        err instanceof UpstreamError && err.statusCode === 502 && /Upstream error 502/.test(err.message),
    );
  });

  it('throws UpstreamError(502) when the response has no body', async () => {
    installFetchMock(async () => new Response(null, { status: 200 }));
    await assert.rejects(
      streamChatRequest({ apiKey: 'k', body: asBody(base) }),
      (err: unknown) =>
        err instanceof UpstreamError && err.statusCode === 502 && /No response body/.test(err.message),
    );
  });

  it('throws UpstreamError(504) on timeout during streaming open', async () => {
    installFetchMock(async () => {
      throw new DOMException('timeout', 'TimeoutError');
    });
    await assert.rejects(
      streamChatRequest({ apiKey: 'k', body: asBody(base), timeoutMs: 5 }),
      (err: unknown) => err instanceof UpstreamError && err.statusCode === 504,
    );
  });

  it('rethrows non-timeout fetch errors during streaming open', async () => {
    installFetchMock(async () => {
      throw new Error('boom');
    });
    await assert.rejects(streamChatRequest({ apiKey: 'k', body: asBody(base) }), /boom/);
  });
});

describe('compatible base URL constants', () => {
  it('exposes the well-known endpoints used by OpenAI-shaped providers', () => {
    assert.match(OPENAI_API_URL, /api\.openai\.com/);
    assert.match(GOOGLE_OPENAI_COMPAT_URL, /generativelanguage\.googleapis\.com/);
    assert.match(XAI_API_URL, /api\.x\.ai/);
    assert.match(DEEPSEEK_API_URL, /api\.deepseek\.com/);
    assert.match(KIMI_API_URL, /api\.moonshot\.cn/);
    assert.match(PERPLEXITY_API_URL, /api\.perplexity\.ai/);
  });
});
