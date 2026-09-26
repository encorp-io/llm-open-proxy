import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { transformChatRequest } from '../../src/engine.js';
import {
  foundryChatConfig,
  foundryModelInferenceChatConfig,
  buildFoundryUrl,
  convertFoundryRequest,
  sendFoundryRequest,
  streamFoundryRequest,
  getFoundryContentFilterError,
  FOUNDRY_DEPLOYMENTS_API_VERSION,
  FOUNDRY_MODEL_INFERENCE_API_VERSION,
  FOUNDRY_ENTRA_SCOPE,
  AZURE_COGNITIVE_SERVICES_SCOPE,
} from '../../src/providers/foundry.js';
import { UpstreamError } from '../../src/errors.js';
import type { CanonicalChatRequest } from '../../src/types.js';

const base: CanonicalChatRequest = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
};

const ENDPOINT = 'https://res.services.ai.azure.com';

// ---------------------------------------------------------------------------
// Config — OpenAI-compatible surfaces
// ---------------------------------------------------------------------------

describe('foundryChatConfig', () => {
  const gated = {
    temperature: 0.5,
    top_p: 0.9,
    frequency_penalty: 0.1,
    presence_penalty: 0.2,
    logit_bias: { '1': 1 },
    logprobs: true,
    top_logprobs: 2,
    stop: 'END',
  } as const;

  // gpt-6 rejections verified live against Foundry (2026-09): temperature,
  // top_p, both penalties, logprobs/top_logprobs, logit_bias and stop.
  for (const model of ['o3-mini', 'o1', 'o4-mini', 'gpt-5', 'GPT-5.1-chat', 'gpt-6-luna', 'gpt-6-sol']) {
    it(`drops sampling/logprob/stop controls on reasoning deployment ${model}`, () => {
      const { body, warnings } = transformChatRequest(
        { ...base, model, ...gated },
        foundryChatConfig,
        'foundry',
      );
      for (const field of Object.keys(gated)) {
        assert.equal(body[field], undefined, `${field} should be dropped`);
        assert.ok(
          warnings.some((w) => w.includes(`'${field}' unsupported on reasoning model ${model}`)),
          `expected warning for ${field}`,
        );
      }
    });
  }

  it('keeps sampling/logprob/stop controls on regular deployments', () => {
    const { body, warnings } = transformChatRequest({ ...base, ...gated }, foundryChatConfig, 'foundry');
    for (const [field, value] of Object.entries(gated)) assert.deepEqual(body[field], value);
    assert.deepEqual(warnings, []);
  });

  it('drops top_k with a warning', () => {
    const { body, warnings } = transformChatRequest({ ...base, top_k: 5 }, foundryChatConfig, 'foundry');
    assert.equal(body.top_k, undefined);
    assert.ok(warnings.some((w) => w.includes("'top_k' dropped for foundry")));
  });

  it('forwards max_completion_tokens and upgrades legacy max_tokens', () => {
    assert.equal(
      transformChatRequest({ ...base, max_completion_tokens: 10 }, foundryChatConfig, 'foundry').body
        .max_completion_tokens,
      10,
    );
    const legacy = transformChatRequest({ ...base, max_tokens: 20 }, foundryChatConfig, 'foundry').body;
    assert.equal(legacy.max_completion_tokens, 20);
    assert.equal(legacy.max_tokens, undefined);
  });

  it('passes through the rest of the OpenAI surface', () => {
    const { body, warnings } = transformChatRequest(
      {
        ...base,
        n: 2,
        stop: 'x',
        seed: 1,
        user: 'u',
        response_format: { type: 'json_object' },
        tools: [{ type: 'function', function: { name: 'f' } }],
        tool_choice: 'required',
        parallel_tool_calls: false,
        reasoning_effort: 'low',
        stream: true,
        stream_options: { include_usage: true },
      },
      foundryChatConfig,
      'foundry',
    );
    assert.equal(body.n, 2);
    assert.equal(body.stop, 'x');
    assert.equal(body.seed, 1);
    assert.equal(body.user, 'u');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.ok(Array.isArray(body.tools));
    assert.equal(body.tool_choice, 'required');
    assert.equal(body.parallel_tool_calls, false);
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.deepEqual(warnings, []);
  });
});

describe('foundryChatConfig — reasoning_effort', () => {
  const weather = { type: 'function' as const, function: { name: 'get_weather' } };
  const convert = (req: Partial<CanonicalChatRequest>) =>
    transformChatRequest({ ...base, ...req }, foundryChatConfig, 'foundry');

  for (const reasoning_effort of [undefined, 'high'] as const) {
    it(`forces 'none' on gpt-6 with function tools (reasoning_effort=${reasoning_effort})`, () => {
      const { body, warnings } = convert({ model: 'gpt-6-sol', tools: [weather], reasoning_effort });
      assert.equal(body.reasoning_effort, 'none');
      assert.ok(warnings.some((w) => w.includes("reasoning_effort forced to 'none' for gpt-6-sol")));
    });
  }

  it("maps 'minimal' to 'none' on gpt-6 (no minimal level)", () => {
    const { body, warnings } = convert({ model: 'gpt-6-luna', reasoning_effort: 'minimal' });
    assert.equal(body.reasoning_effort, 'none');
    assert.ok(warnings.some((w) => w.includes("'minimal' unsupported on gpt-6-luna")));
  });

  it('passes other levels through on gpt-6 without tools (and with an empty tools array)', () => {
    assert.equal(convert({ model: 'gpt-6-sol', reasoning_effort: 'high' }).body.reasoning_effort, 'high');
    assert.equal(convert({ model: 'gpt-6-sol', tools: [], reasoning_effort: 'low' }).body.reasoning_effort, 'low');
    const unset = convert({ model: 'gpt-6-sol' });
    assert.equal(unset.body.reasoning_effort, undefined);
    assert.deepEqual(unset.warnings, []);
  });

  it('leaves other models alone, tools or not', () => {
    const { body, warnings } = convert({ model: 'DeepSeek-V4.1-Flash', tools: [weather], reasoning_effort: 'minimal' });
    assert.equal(body.reasoning_effort, 'minimal');
    assert.deepEqual(warnings, []);
    assert.equal(convert({ model: 'gpt-5', tools: [weather] }).body.reasoning_effort, undefined);
  });

  it('applies the same rule on the Model Inference API', () => {
    const { body } = transformChatRequest(
      { ...base, model: 'gpt-6-sol', tools: [weather] },
      foundryModelInferenceChatConfig,
      'foundry',
    );
    assert.equal(body.reasoning_effort, 'none');
  });
});

// ---------------------------------------------------------------------------
// Config — Model Inference API
// ---------------------------------------------------------------------------

describe('foundryModelInferenceChatConfig', () => {
  it('renames max_completion_tokens / max_tokens to max_tokens', () => {
    assert.equal(
      transformChatRequest({ ...base, max_completion_tokens: 30 }, foundryModelInferenceChatConfig, 'foundry')
        .body.max_tokens,
      30,
    );
    assert.equal(
      transformChatRequest({ ...base, max_tokens: 40 }, foundryModelInferenceChatConfig, 'foundry').body
        .max_tokens,
      40,
    );
  });

  it('routes OpenAI reasoning deployments through their rules (max_completion_tokens, no sampling/stop)', () => {
    const { body, warnings } = transformChatRequest(
      {
        ...base,
        model: 'gpt-6-sol',
        max_tokens: 64,
        temperature: 0.5,
        top_p: 0.9,
        frequency_penalty: 0.1,
        presence_penalty: 0.1,
        stop: 'END',
        seed: 1,
      },
      foundryModelInferenceChatConfig,
      'foundry',
    );
    assert.equal(body.max_completion_tokens, 64);
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.seed, 1);
    for (const field of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'stop']) {
      assert.equal(body[field], undefined, `${field} should be dropped`);
      assert.ok(warnings.some((w) => w.includes(`'${field}' unsupported on reasoning model gpt-6-sol`)));
    }
  });

  it('wraps a string stop into an array and keeps arrays as-is', () => {
    assert.deepEqual(
      transformChatRequest({ ...base, stop: 'END' }, foundryModelInferenceChatConfig, 'foundry').body.stop,
      ['END'],
    );
    assert.deepEqual(
      transformChatRequest({ ...base, stop: ['A', 'B'] }, foundryModelInferenceChatConfig, 'foundry').body.stop,
      ['A', 'B'],
    );
  });

  it('passes through the fields in the Model Inference schema', () => {
    const { body, warnings } = transformChatRequest(
      {
        ...base,
        temperature: 0.3,
        top_p: 0.8,
        frequency_penalty: 0.1,
        presence_penalty: 0.1,
        seed: 3,
        response_format: { type: 'json_object' },
        tools: [{ type: 'function', function: { name: 'f' } }],
        tool_choice: 'auto',
        stream: true,
      },
      foundryModelInferenceChatConfig,
      'foundry',
    );
    assert.equal(body.temperature, 0.3);
    assert.equal(body.top_p, 0.8);
    assert.equal(body.frequency_penalty, 0.1);
    assert.equal(body.presence_penalty, 0.1);
    assert.equal(body.seed, 3);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.ok(Array.isArray(body.tools));
    assert.equal(body.tool_choice, 'auto');
    assert.equal(body.stream, true);
    assert.deepEqual(warnings, []);
  });

  it('drops fields outside the Model Inference schema', () => {
    const dropped = {
      top_k: 5,
      n: 2,
      logit_bias: { '1': 1 },
      user: 'u',
      logprobs: true,
      top_logprobs: 2,
      parallel_tool_calls: true,
    } as const;
    const { body, warnings } = transformChatRequest(
      { ...base, ...dropped },
      foundryModelInferenceChatConfig,
      'foundry',
    );
    for (const field of Object.keys(dropped)) {
      assert.equal(body[field], undefined, `${field} should be dropped`);
      assert.ok(warnings.some((w) => w.includes(`'${field}' dropped for foundry`)), `warning for ${field}`);
    }
  });

  it('forwards reasoning_effort and stream_options (verified live despite the schema)', () => {
    const { body, warnings } = transformChatRequest(
      { ...base, model: 'DeepSeek-V4.1-Flash', reasoning_effort: 'low', stream_options: { include_usage: true } },
      foundryModelInferenceChatConfig,
      'foundry',
    );
    assert.equal(body.reasoning_effort, 'low');
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.deepEqual(warnings, []);
  });
});

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

describe('buildFoundryUrl', () => {
  it('defaults to the v1 API with no api-version', () => {
    assert.equal(
      buildFoundryUrl({ endpoint: ENDPOINT }, 'gpt-4o'),
      `${ENDPOINT}/openai/v1/chat/completions`,
    );
  });

  it('adds an explicit api-version to the v1 API (e.g. preview)', () => {
    assert.equal(
      buildFoundryUrl({ endpoint: ENDPOINT, apiVersion: 'preview' }, 'm'),
      `${ENDPOINT}/openai/v1/chat/completions?api-version=preview`,
    );
  });

  it('tolerates trailing slashes and an already-present API prefix', () => {
    for (const endpoint of [`${ENDPOINT}/`, `${ENDPOINT}/openai/v1/`, `${ENDPOINT}/OpenAI`]) {
      assert.equal(buildFoundryUrl({ endpoint }, 'm'), `${ENDPOINT}/openai/v1/chat/completions`);
    }
  });

  it('builds project-scoped v1 URLs', () => {
    const project = `${ENDPOINT}/api/projects/proj`;
    assert.equal(buildFoundryUrl({ endpoint: project }, 'm'), `${project}/openai/v1/chat/completions`);
  });

  it('builds dated deployment URLs, defaulting the deployment to the model', () => {
    assert.equal(
      buildFoundryUrl({ endpoint: 'https://res.openai.azure.com/openai', api: 'openai-deployments' }, 'my gpt'),
      `https://res.openai.azure.com/openai/deployments/my%20gpt/chat/completions?api-version=${FOUNDRY_DEPLOYMENTS_API_VERSION}`,
    );
    assert.equal(
      buildFoundryUrl(
        {
          endpoint: 'https://res.openai.azure.com',
          api: 'openai-deployments',
          deployment: 'prod',
          apiVersion: '2025-04-01-preview',
        },
        'ignored',
      ),
      'https://res.openai.azure.com/openai/deployments/prod/chat/completions?api-version=2025-04-01-preview',
    );
  });

  it('uses the resource endpoint for APIs that project endpoints do not serve', () => {
    const project = `${ENDPOINT}/api/projects/my-proj/`;
    assert.equal(
      buildFoundryUrl({ endpoint: project, api: 'openai-deployments' }, 'd'),
      `${ENDPOINT}/openai/deployments/d/chat/completions?api-version=${FOUNDRY_DEPLOYMENTS_API_VERSION}`,
    );
    assert.equal(
      buildFoundryUrl({ endpoint: project, api: 'model-inference' }, 'd'),
      `${ENDPOINT}/models/chat/completions?api-version=${FOUNDRY_MODEL_INFERENCE_API_VERSION}`,
    );
    assert.equal(buildFoundryUrl({ endpoint: `${project}anthropic`, api: 'anthropic' }, 'c'), `${ENDPOINT}/anthropic/v1/messages`);
  });

  it('builds Model Inference URLs with the default api-version', () => {
    assert.equal(
      buildFoundryUrl({ endpoint: `${ENDPOINT}/models`, api: 'model-inference' }, 'm'),
      `${ENDPOINT}/models/chat/completions?api-version=${FOUNDRY_MODEL_INFERENCE_API_VERSION}`,
    );
  });

  it('builds Claude URLs and ignores api-version for them', () => {
    for (const endpoint of [ENDPOINT, `${ENDPOINT}/anthropic`, `${ENDPOINT}/anthropic/v1`]) {
      assert.equal(
        buildFoundryUrl({ endpoint, api: 'anthropic', apiVersion: 'x' }, 'claude'),
        `${ENDPOINT}/anthropic/v1/messages`,
      );
    }
  });

  it('uses a full url override verbatim', () => {
    const url = 'https://gw.example.com/foundry/chat/completions?x=1';
    assert.equal(buildFoundryUrl({ url, endpoint: ENDPOINT, api: 'model-inference' }, 'm'), url);
  });

  it('throws when neither endpoint nor url is given', () => {
    assert.throws(() => buildFoundryUrl({}, 'm'), /endpoint/);
  });
});

// ---------------------------------------------------------------------------
// convertFoundryRequest
// ---------------------------------------------------------------------------

describe('convertFoundryRequest', () => {
  it('defaults to the v1 config and strips reasoning_content from history', () => {
    const { body } = convertFoundryRequest({
      ...base,
      max_tokens: 5,
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', reasoning_content: 'thought' },
      ],
    });
    assert.equal(body.max_completion_tokens, 5);
    const msgs = body.messages as Array<Record<string, unknown>>;
    assert.equal(msgs[1].reasoning_content, undefined);
  });

  it('merges provider_options.foundry', () => {
    const { body } = convertFoundryRequest({
      ...base,
      provider_options: { foundry: { user_security_context: { end_user_id: 'u1' } }, openai: { x: 1 } },
    });
    assert.deepEqual(body.user_security_context, { end_user_id: 'u1' });
    assert.equal(body.x, undefined);
  });

  it('uses the Model Inference config for api model-inference', () => {
    const { body } = convertFoundryRequest({ ...base, max_completion_tokens: 9 }, { api: 'model-inference' });
    assert.equal(body.max_tokens, 9);
    assert.equal(body.max_completion_tokens, undefined);
  });

  it('produces an Anthropic Messages body for api anthropic', () => {
    const { body, warnings } = convertFoundryRequest(
      { model: 'claude-sonnet-5', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] },
      { api: 'anthropic' },
    );
    assert.equal(body.system, 's');
    assert.equal(body.max_tokens, 4096);
    assert.ok(warnings.some((w) => /max_tokens missing/.test(w)));
  });

  it('uses the OpenAI-compatible config for the dated API, reasoning_effort included', () => {
    // The GA api-version's published schema omits reasoning_effort and
    // stream_options, but the service accepts both (verified live).
    const { body, warnings } = convertFoundryRequest(
      { ...base, reasoning_effort: 'high', stream_options: { include_usage: true } },
      { api: 'openai-deployments' },
    );
    assert.equal(body.reasoning_effort, 'high');
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.deepEqual(warnings, []);
  });
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

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function completion(message: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o-2024-11-20',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    ...extra,
  };
}

const headersOf = (i = 0) => calls[i].init.headers as Record<string, string>;
const payloadOf = (i = 0) => JSON.parse(calls[i].init.body as string) as Record<string, unknown>;

describe('sendFoundryRequest — OpenAI surfaces', () => {
  it('posts to the v1 URL with api-key auth, stream:false and no stream_options', async () => {
    installFetchMock(async () => jsonResponse(completion({ content: 'Hello' })));
    const { response, usage, warnings } = await sendFoundryRequest({
      endpoint: ENDPOINT,
      apiKey: 'key-1',
      body: { ...base, temperature: 0.2, stream_options: { include_usage: true } },
    });

    assert.equal(calls[0].url, `${ENDPOINT}/openai/v1/chat/completions`);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(headersOf()['api-key'], 'key-1');
    assert.equal(headersOf()['Content-Type'], 'application/json');
    assert.equal(headersOf()['Authorization'], undefined);
    const payload = payloadOf();
    assert.equal(payload.stream, false);
    assert.equal(payload.stream_options, undefined);
    assert.equal(payload.temperature, 0.2);
    assert.equal(payload.model, 'gpt-4o');

    assert.equal(response.choices[0].message.content, 'Hello');
    assert.deepEqual(usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
    assert.deepEqual(warnings, []);
  });

  it('sends an Entra ID bearer token from a sync or async getToken', async () => {
    installFetchMock(async () => jsonResponse(completion({ content: 'x' })));
    await sendFoundryRequest({ endpoint: ENDPOINT, getToken: () => 'tok-sync', body: base });
    await sendFoundryRequest({ endpoint: ENDPOINT, getToken: async () => 'tok-async', body: base });
    assert.equal(headersOf(0)['Authorization'], 'Bearer tok-sync');
    assert.equal(headersOf(1)['Authorization'], 'Bearer tok-async');
    assert.equal(headersOf(0)['api-key'], undefined);
  });

  it('treats an empty apiKey as absent when a token provider is given', async () => {
    installFetchMock(async () => jsonResponse(completion({ content: 'x' })));
    await sendFoundryRequest({ endpoint: ENDPOINT, apiKey: '', getToken: () => 't', body: base });
    assert.equal(headersOf()['Authorization'], 'Bearer t');
  });

  it('rejects when both or neither credentials are provided', async () => {
    installFetchMock(async () => jsonResponse(completion({ content: 'x' })));
    await assert.rejects(
      sendFoundryRequest({ endpoint: ENDPOINT, apiKey: 'k', getToken: () => 't', body: base }),
      /either `apiKey` or `getToken`/,
    );
    await assert.rejects(sendFoundryRequest({ endpoint: ENDPOINT, body: base }), /is required/);
    assert.equal(calls.length, 0);
  });

  it('adds the extra-parameters header and merges custom headers last', async () => {
    installFetchMock(async () => jsonResponse(completion({ content: 'x' })));
    await sendFoundryRequest({
      endpoint: ENDPOINT,
      api: 'model-inference',
      apiKey: 'k',
      extraParameters: 'pass-through',
      headers: { 'x-ms-client-request-id': 'req-1' },
      body: { ...base, max_completion_tokens: 12, provider_options: { foundry: { safe_prompt: true } } },
    });
    assert.equal(
      calls[0].url,
      `${ENDPOINT}/models/chat/completions?api-version=${FOUNDRY_MODEL_INFERENCE_API_VERSION}`,
    );
    assert.equal(headersOf()['extra-parameters'], 'pass-through');
    assert.equal(headersOf()['x-ms-client-request-id'], 'req-1');
    assert.equal(payloadOf().max_tokens, 12);
    assert.equal(payloadOf().safe_prompt, true);
  });

  it('routes the dated API to the deployment path and forwards reasoning_effort', async () => {
    installFetchMock(async () => jsonResponse(completion({ content: 'x' })));
    const { warnings } = await sendFoundryRequest({
      endpoint: 'https://res.openai.azure.com',
      api: 'openai-deployments',
      deployment: 'chat-prod',
      apiKey: 'k',
      body: { ...base, reasoning_effort: 'low' },
    });
    assert.equal(
      calls[0].url,
      `https://res.openai.azure.com/openai/deployments/chat-prod/chat/completions?api-version=${FOUNDRY_DEPLOYMENTS_API_VERSION}`,
    );
    assert.equal(payloadOf().reasoning_effort, 'low');
    assert.deepEqual(warnings, []);
  });

  it('passes Azure content-filter annotations through on the response', async () => {
    const promptFilter = [{ prompt_index: 0, content_filter_results: { hate: { filtered: false, severity: 'safe' } } }];
    installFetchMock(async () =>
      jsonResponse(
        completion(
          { content: 'ok' },
          {
            prompt_filter_results: promptFilter,
            usage: {
              prompt_tokens: 1,
              completion_tokens: 2,
              total_tokens: 3,
              completion_tokens_details: { reasoning_tokens: 1 },
            },
          },
        ),
      ),
    );
    const { response } = await sendFoundryRequest({ endpoint: ENDPOINT, apiKey: 'k', body: base });
    assert.deepEqual(response.prompt_filter_results, promptFilter);
    assert.equal(response.usage.completion_tokens_details?.reasoning_tokens, 1);
  });

  it('defaults usage to zeros when the upstream omits it', async () => {
    installFetchMock(async () =>
      jsonResponse({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [] }),
    );
    const { usage } = await sendFoundryRequest({ endpoint: ENDPOINT, apiKey: 'k', body: base });
    assert.deepEqual(usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
});

describe('sendFoundryRequest — <think> extraction', () => {
  async function send(message: Record<string, unknown>, extractThinkTags?: boolean) {
    installFetchMock(async () => jsonResponse(completion(message)));
    const { response } = await sendFoundryRequest({
      endpoint: ENDPOINT,
      apiKey: 'k',
      body: { ...base, model: 'DeepSeek-R1' },
      ...(extractThinkTags === undefined ? {} : { extractThinkTags }),
    });
    return response.choices[0].message;
  }

  it('moves a leading think block into reasoning_content', async () => {
    const msg = await send({ content: '\n<think>\nStep 1.\nStep 2.\n</think>\n\nThe answer is 4.' });
    assert.equal(msg.reasoning_content, 'Step 1.\nStep 2.');
    assert.equal(msg.content, 'The answer is 4.');
  });

  it('strips an empty think block', async () => {
    const msg = await send({ content: '<think>\n\n</think>\n\nHi' });
    assert.equal(msg.reasoning_content, '');
    assert.equal(msg.content, 'Hi');
  });

  it('keeps an unterminated think block as reasoning', async () => {
    const msg = await send({ content: '<think>cut off by max_tokens' });
    assert.equal(msg.reasoning_content, 'cut off by max_tokens');
    assert.equal(msg.content, '');
  });

  it('leaves content without a leading think block untouched', async () => {
    for (const content of ['Use the <think> tag like this: <think>x</think>', '<th', '  plain']) {
      const msg = await send({ content });
      assert.equal(msg.content, content);
      assert.equal(msg.reasoning_content, undefined);
    }
  });

  it('does not touch messages that already carry reasoning_content or have null content', async () => {
    const native = await send({ content: '<think>a</think>b', reasoning_content: 'native' });
    assert.equal(native.content, '<think>a</think>b');
    assert.equal(native.reasoning_content, 'native');
    const toolCall = await send({ content: null, tool_calls: [] });
    assert.equal(toolCall.content, null);
  });

  it('can be disabled with extractThinkTags: false', async () => {
    const msg = await send({ content: '<think>a</think>b' }, false);
    assert.equal(msg.content, '<think>a</think>b');
    assert.equal(msg.reasoning_content, undefined);
  });

  it('tolerates responses with no choices or a choice without a message', async () => {
    installFetchMock(async () =>
      jsonResponse({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0 }] }),
    );
    const { response } = await sendFoundryRequest({ endpoint: ENDPOINT, apiKey: 'k', body: base });
    assert.equal(response.choices.length, 1);

    installFetchMock(async () => jsonResponse({ id: 'x', object: 'chat.completion', created: 1, model: 'm' }));
    const empty = await sendFoundryRequest({ endpoint: ENDPOINT, apiKey: 'k', body: base });
    assert.equal(empty.response.choices, undefined);
  });
});

describe('sendFoundryRequest — errors', () => {
  it('reads the OpenAI-style envelope and the retry-after-ms hint', async () => {
    installFetchMock(async () =>
      jsonResponse(
        { error: { code: '429', message: 'Rate limit is exceeded. Try again in 2 seconds.' } },
        429,
        { 'retry-after-ms': '1500', 'retry-after': '2' },
      ),
    );
    await assert.rejects(
      sendFoundryRequest({ endpoint: ENDPOINT, apiKey: 'k', body: base }),
      (err: unknown) =>
        err instanceof UpstreamError &&
        err.statusCode === 429 &&
        err.retryAfterMs === 1500 &&
        /Rate limit/.test(err.message),
    );
  });

  it('reads the flat {statusCode, message} Entra token envelope', async () => {
    installFetchMock(async () =>
      jsonResponse({ statusCode: 401, message: 'Unauthorized. Access token is missing' }, 401),
    );
    await assert.rejects(
      sendFoundryRequest({ endpoint: ENDPOINT, getToken: () => 'bad', body: base }),
      (err: unknown) =>
        err instanceof UpstreamError &&
        err.statusCode === 401 &&
        err.message === 'Unauthorized. Access token is missing' &&
        err.retryAfterMs === undefined,
    );
  });

  for (const [label, response] of [
    ['non-JSON', new Response('<html>bad gateway</html>', { status: 502 })],
    ['a JSON scalar', jsonResponse('oops', 503)],
    ['JSON null', jsonResponse(null, 500)],
    ['an envelope without a message', jsonResponse({ error: { code: 'x' } }, 500)],
  ] as const) {
    it(`falls back to a default message for ${label} error bodies`, async () => {
      installFetchMock(async () => response.clone());
      await assert.rejects(
        sendFoundryRequest({ endpoint: ENDPOINT, apiKey: 'k', body: base }),
        (err: unknown) =>
          err instanceof UpstreamError && err.message === `Foundry error ${response.status}`,
      );
    });
  }

  it('throws UpstreamError(504) on timeout', async () => {
    installFetchMock(async () => {
      throw new DOMException('timeout', 'TimeoutError');
    });
    await assert.rejects(
      sendFoundryRequest({ endpoint: ENDPOINT, apiKey: 'k', body: base, timeoutMs: 5 }),
      (err: unknown) => err instanceof UpstreamError && err.statusCode === 504 && /timed out after 5ms/.test(err.message),
    );
  });

  it('rethrows non-timeout fetch errors as-is', async () => {
    installFetchMock(async () => {
      throw new Error('ECONNRESET');
    });
    await assert.rejects(sendFoundryRequest({ endpoint: ENDPOINT, apiKey: 'k', body: base }), /ECONNRESET/);
  });

  it('forwards an external AbortSignal', async () => {
    const ac = new AbortController();
    installFetchMock(async (_url, init) => {
      assert.ok(init.signal, 'signal forwarded');
      return jsonResponse(completion({ content: 'x' }));
    });
    await sendFoundryRequest({ endpoint: ENDPOINT, apiKey: 'k', body: base, signal: ac.signal });
  });
});

describe('sendFoundryRequest — Claude (api: anthropic)', () => {
  const claudeReply = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hi from Claude' }],
    model: 'claude-sonnet-5',
    stop_reason: 'end_turn',
    usage: { input_tokens: 7, output_tokens: 4 },
  };

  it('translates to the Messages API with x-api-key auth on the Foundry URL', async () => {
    installFetchMock(async () => jsonResponse(claudeReply));
    const { response, usage } = await sendFoundryRequest({
      endpoint: ENDPOINT,
      api: 'anthropic',
      apiKey: 'foundry-key',
      headers: { 'anthropic-beta': 'context-management-2025-06-27' },
      body: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 50 },
    });
    assert.equal(calls[0].url, `${ENDPOINT}/anthropic/v1/messages`);
    const headers = headersOf();
    assert.equal(headers['x-api-key'], 'foundry-key');
    assert.equal(headers['anthropic-version'], '2023-06-01');
    assert.equal(headers['anthropic-beta'], 'context-management-2025-06-27');
    assert.equal(payloadOf().max_tokens, 50);
    assert.equal(response.choices[0].message.content, 'Hi from Claude');
    assert.deepEqual(usage, { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 });
  });

  it("keeps Azure's gateway error message on send and stream (Entra 401 flat envelope)", async () => {
    const azure401 = 'Unauthorized. Access token is missing, invalid, audience is incorrect, or have expired.';
    installFetchMock(async () => jsonResponse({ statusCode: 401, message: azure401 }, 401));
    const opts = {
      endpoint: ENDPOINT,
      api: 'anthropic' as const,
      getToken: () => 'expired',
      body: { model: 'claude-sonnet-5', messages: [{ role: 'user' as const, content: 'hi' }] },
    };
    const isAzure401 = (err: unknown) =>
      err instanceof UpstreamError && err.statusCode === 401 && err.message === azure401;
    await assert.rejects(sendFoundryRequest(opts), isAzure401);
    await assert.rejects(streamFoundryRequest(opts), isAzure401);
  });

  it('uses Entra ID bearer auth without leaking an x-api-key header', async () => {
    installFetchMock(async () => jsonResponse(claudeReply));
    await sendFoundryRequest({
      endpoint: ENDPOINT,
      api: 'anthropic',
      getToken: () => 'entra',
      body: { model: 'claude-mythos-5', messages: [{ role: 'user', content: 'hi' }] },
    });
    const headers = headersOf();
    assert.equal(headers['Authorization'], 'Bearer entra');
    assert.equal(headers['x-api-key'], undefined);
  });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
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
  return out + decoder.decode();
}

/** Split emitted SSE into payload strings. */
function payloads(text: string): string[] {
  return text
    .split('\n\n')
    .filter((e) => e.length > 0)
    .map((e) => {
      assert.ok(e.startsWith('data: '), `every event must be a data line, got ${JSON.stringify(e)}`);
      return e.slice(6);
    });
}

type Chunk = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { content?: string | null; reasoning_content?: string; role?: string };
    finish_reason: string | null;
    content_filter_results?: unknown;
  }>;
  usage?: unknown;
};

function jsonChunks(text: string): Chunk[] {
  return payloads(text)
    .filter((p) => p !== '[DONE]')
    .map((p) => JSON.parse(p) as Chunk);
}

const data = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

function contentChunk(content: string | null, extra: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-9',
    object: 'chat.completion.chunk',
    created: 99,
    model: 'gpt-4o',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
    ...extra,
  };
}

const PROMPT_FILTER = [
  { prompt_index: 0, content_filter_results: { jailbreak: { filtered: false, detected: false } } },
];

describe('streamFoundryRequest — Azure normalization', () => {
  it('drops the prompt-annotation chunk, keeps its verdicts and captures usage', async () => {
    installFetchMock(async () =>
      sseResponse([
        data({ id: '', object: '', created: 0, model: '', prompt_filter_results: PROMPT_FILTER, choices: [], usage: null }),
        data({ ...contentChunk('Hel'), usage: null }),
        data(contentChunk('lo')),
        data({ ...contentChunk(null), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        data({ ...contentChunk(null), choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }),
        'data: [DONE]\n\n',
      ]),
    );
    const { stream, getUsage, getPromptFilterResults, warnings } = await streamFoundryRequest({
      endpoint: ENDPOINT,
      apiKey: 'k',
      body: base,
    });
    const text = await readAllText(stream);
    const chunks = jsonChunks(text);

    assert.equal(chunks.length, 4, 'annotation chunk dropped, usage chunk kept');
    assert.ok(chunks.every((c) => c.id === 'chatcmpl-9'));
    assert.equal(chunks.map((c) => c.choices[0]?.delta.content ?? '').join(''), 'Hello');
    assert.ok(payloads(text).at(-1) === '[DONE]');
    assert.deepEqual(getUsage(), { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
    assert.deepEqual(getPromptFilterResults(), PROMPT_FILTER);
    assert.deepEqual(warnings, []);
  });

  it('forces stream:true and include_usage (merged with caller stream_options) on v1', async () => {
    installFetchMock(async () => sseResponse(['data: [DONE]\n\n']));
    await streamFoundryRequest({
      endpoint: ENDPOINT,
      apiKey: 'k',
      body: { ...base, stream_options: { include_usage: false, include_obfuscation: false } as never },
    });
    const payload = payloadOf();
    assert.equal(payload.stream, true);
    assert.deepEqual(payload.stream_options, { include_usage: true, include_obfuscation: false });
  });

  it('requests stream usage on a preview dated api-version', async () => {
    installFetchMock(async () => sseResponse(['data: [DONE]\n\n']));
    await streamFoundryRequest({
      endpoint: ENDPOINT,
      api: 'openai-deployments',
      apiVersion: '2025-04-01-preview',
      apiKey: 'k',
      body: base,
    });
    assert.deepEqual(payloadOf().stream_options, { include_usage: true });
  });

  it('also requests stream usage on the GA dated and Model Inference APIs', async () => {
    installFetchMock(async () => sseResponse(['data: [DONE]\n\n']));
    await streamFoundryRequest({ endpoint: ENDPOINT, api: 'openai-deployments', apiKey: 'k', body: base });
    await streamFoundryRequest({ endpoint: ENDPOINT, api: 'model-inference', apiKey: 'k', body: base });
    assert.deepEqual(payloadOf(0).stream_options, { include_usage: true });
    assert.deepEqual(payloadOf(1).stream_options, { include_usage: true });
    assert.equal(payloadOf(1).stream, true);
  });

  it('backfills async-filter annotation chunks (blank id, no delta) and the legacy prompt_annotations key', async () => {
    installFetchMock(async () =>
      sseResponse([
        data({ id: '', object: '', created: 0, model: '', prompt_annotations: PROMPT_FILTER, choices: [] }),
        data(contentChunk('Hi')),
        data({
          id: '',
          object: '',
          created: 0,
          model: '',
          choices: [
            {
              index: 0,
              finish_reason: null,
              content_filter_results: { hate: { filtered: false, severity: 'safe' } },
              content_filter_offsets: { check_offset: 0, start_offset: 0, end_offset: 2 },
            },
          ],
        }),
        'data: [DONE]\n\n',
      ]),
    );
    const { stream, getPromptFilterResults } = await streamFoundryRequest({ endpoint: ENDPOINT, apiKey: 'k', body: base });
    const chunks = jsonChunks(await readAllText(stream));
    const annotation = chunks[1];
    assert.equal(annotation.id, 'chatcmpl-9');
    assert.equal(annotation.model, 'gpt-4o');
    assert.equal(annotation.created, 99);
    assert.equal(annotation.object, 'chat.completion.chunk');
    assert.deepEqual(annotation.choices[0].delta, {});
    assert.ok(annotation.choices[0].content_filter_results);
    assert.deepEqual(getPromptFilterResults(), PROMPT_FILTER);
  });

  it('drops choice-less, usage-less chunks that carry no filter results', async () => {
    installFetchMock(async () => sseResponse([data({ id: '', model: '' }), data(contentChunk('a')), 'data: [DONE]\n\n']));
    const { stream, getPromptFilterResults } = await streamFoundryRequest({ endpoint: ENDPOINT, apiKey: 'k', body: base });
    assert.equal(jsonChunks(await readAllText(stream)).length, 1);
    assert.deepEqual(getPromptFilterResults(), []);
  });

  it('reassembles SSE lines split across network reads and ignores non-data lines', async () => {
    const line = data(contentChunk('split'));
    installFetchMock(async () =>
      sseResponse([': keep-alive\n\n', 'event: message\n', line.slice(0, 17), line.slice(17), 'data: \n\n', 'data: [DONE]\n\n']),
    );
    const { stream } = await streamFoundryRequest({ endpoint: ENDPOINT, apiKey: 'k', body: base });
    const text = await readAllText(stream);
    assert.deepEqual(payloads(text).length, 2);
    assert.equal(jsonChunks(text)[0].choices[0].delta.content, 'split');
  });

  it('forwards unparseable and scalar payloads verbatim', async () => {
    installFetchMock(async () => sseResponse(['data: not-json\n\n', 'data: 42\n\n', 'data: [DONE]\n\n']));
    const { stream } = await streamFoundryRequest({ endpoint: ENDPOINT, apiKey: 'k', body: base });
    assert.deepEqual(payloads(await readAllText(stream)), ['not-json', '42', '[DONE]']);
  });

  it('handles a final event without a trailing newline and a stream without [DONE]', async () => {
    installFetchMock(async () => sseResponse([data(contentChunk('a')), `data: ${JSON.stringify(contentChunk('b'))}`]));
    const { stream } = await streamFoundryRequest({ endpoint: ENDPOINT, apiKey: 'k', body: base });
    const text = await readAllText(stream);
    assert.equal(jsonChunks(text).map((c) => c.choices[0].delta.content).join(''), 'ab');
    assert.ok(!text.includes('[DONE]'));
  });

  it('reports zero usage when the upstream never sends it', async () => {
    installFetchMock(async () => sseResponse([data(contentChunk('a')), 'data: [DONE]\n\n']));
    const { stream, getUsage } = await streamFoundryRequest({ endpoint: ENDPOINT, apiKey: 'k', body: base });
    await readAllText(stream);
    assert.deepEqual(getUsage(), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it('throws UpstreamError on non-2xx and 502 when the body is missing', async () => {
    installFetchMock(async () => jsonResponse({ error: { code: 'DeploymentNotFound', message: 'no deployment' } }, 404));
    await assert.rejects(
      streamFoundryRequest({ endpoint: ENDPOINT, apiKey: 'k', body: base }),
      (err: unknown) => err instanceof UpstreamError && err.statusCode === 404 && err.message === 'no deployment',
    );
    installFetchMock(async () => new Response(null, { status: 200 }));
    await assert.rejects(
      streamFoundryRequest({ endpoint: ENDPOINT, apiKey: 'k', body: base }),
      (err: unknown) => err instanceof UpstreamError && err.statusCode === 502,
    );
  });
});

describe('streamFoundryRequest — <think> extraction', () => {
  async function run(chunks: string[], extractThinkTags?: boolean) {
    installFetchMock(async () => sseResponse(chunks));
    const { stream } = await streamFoundryRequest({
      endpoint: ENDPOINT,
      apiKey: 'k',
      body: { ...base, model: 'DeepSeek-R1' },
      ...(extractThinkTags === undefined ? {} : { extractThinkTags }),
    });
    const chunksOut = jsonChunks(await readAllText(stream));
    const content = chunksOut.map((c) => c.choices[0]?.delta.content ?? '').join('');
    const reasoning = chunksOut.map((c) => c.choices[0]?.delta.reasoning_content ?? '').join('');
    return { chunksOut, content, reasoning };
  }

  const stop = (extra: Record<string, unknown> = {}) =>
    data({ ...contentChunk(null), choices: [{ index: 0, delta: {}, finish_reason: 'stop', ...extra }] });

  it('splits tags straddling chunk boundaries into reasoning_content and content', async () => {
    const pieces = ['<thi', 'nk>\nLet me', ' think.</th', 'ink>\n\nAns', 'wer.'];
    const { content, reasoning } = await run([
      data(contentChunk('', { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })),
      ...pieces.map((p) => data(contentChunk(p))),
      stop(),
      'data: [DONE]\n\n',
    ]);
    assert.equal(reasoning, 'Let me think.');
    assert.equal(content, 'Answer.');
  });

  it('passes through ordinary content, including a later literal <think>', async () => {
    const { content, reasoning } = await run([
      data(contentChunk('<b>bold</b> and <think>')),
      stop(),
      'data: [DONE]\n\n',
    ]);
    assert.equal(content, '<b>bold</b> and <think>');
    assert.equal(reasoning, '');
  });

  it('flushes held-back text on finish_reason', async () => {
    const { chunksOut, content } = await run([data(contentChunk('<th')), stop(), 'data: [DONE]\n\n']);
    assert.equal(content, '<th');
    assert.equal(chunksOut.at(-1)?.choices[0].finish_reason, 'stop');
  });

  it('flushes an unterminated think block on finish_reason as reasoning', async () => {
    const { content, reasoning } = await run([data(contentChunk('<think>partial </th')), stop({ finish_reason: 'length' }), 'data: [DONE]\n\n']);
    assert.equal(reasoning, 'partial </th');
    assert.equal(content, '');
  });

  it('synthesizes a chunk for held-back text when the stream ends without finish_reason', async () => {
    const heldContent = await run([data(contentChunk('<thi')), 'data: [DONE]\n\n']);
    assert.equal(heldContent.content, '<thi');
    const heldReasoning = await run([data(contentChunk('<think>abc</thin'))]);
    assert.equal(heldReasoning.reasoning, 'abc</thin');
  });

  it('keeps per-choice state for n > 1 and appends to native reasoning_content', async () => {
    installFetchMock(async () =>
      sseResponse([
        data({
          ...contentChunk(null),
          choices: [
            { index: 0, delta: { content: '<think>a' }, finish_reason: null },
            { index: 1, delta: { content: '<think>r</think>', reasoning_content: 'native;' }, finish_reason: null },
          ],
        }),
        data({
          ...contentChunk(null),
          choices: [
            { index: 0, delta: { content: '</think>A' }, finish_reason: 'stop' },
            { delta: { content: '<think>x</think>' }, finish_reason: null },
          ],
        }),
        'data: [DONE]\n\n',
      ]),
    );
    const { stream } = await streamFoundryRequest({ endpoint: ENDPOINT, apiKey: 'k', body: base });
    const out = jsonChunks(await readAllText(stream));
    assert.deepEqual(out[0].choices[0].delta, { content: '', reasoning_content: 'a' });
    assert.deepEqual(out[0].choices[1].delta, { content: '', reasoning_content: 'native;r' });
    assert.deepEqual(out[1].choices[0].delta, { content: 'A' });
    // A choice without an index is treated as index 0 (already past its think block).
    assert.deepEqual(out[1].choices[1].delta, { content: '<think>x</think>' });
  });

  it('leaves tool-call deltas (null content) alone', async () => {
    const toolDelta = { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '' } }], content: null };
    const { chunksOut } = await run([
      data({ ...contentChunk(null), choices: [{ index: 0, delta: toolDelta, finish_reason: null }] }),
      stop({ finish_reason: 'tool_calls' }),
      'data: [DONE]\n\n',
    ]);
    assert.deepEqual(chunksOut[0].choices[0].delta, toolDelta);
    assert.deepEqual(chunksOut[1].choices[0].delta, {});
  });

  it('can be disabled with extractThinkTags: false', async () => {
    const { content, reasoning } = await run([data(contentChunk('<think>a</think>b')), stop(), 'data: [DONE]\n\n'], false);
    assert.equal(content, '<think>a</think>b');
    assert.equal(reasoning, '');
  });
});

describe('streamFoundryRequest — Claude (api: anthropic)', () => {
  it('bridges Anthropic SSE to OpenAI chunks and reports no prompt filter results', async () => {
    installFetchMock(async () =>
      sseResponse([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hey"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      ]),
    );
    const { stream, getUsage, getPromptFilterResults } = await streamFoundryRequest({
      endpoint: ENDPOINT,
      api: 'anthropic',
      getToken: async () => 'entra',
      body: { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] },
    });
    const text = await readAllText(stream);
    assert.equal(calls[0].url, `${ENDPOINT}/anthropic/v1/messages`);
    assert.equal(headersOf()['Authorization'], 'Bearer entra');
    assert.equal(payloadOf().stream, true);
    assert.equal(jsonChunks(text)[0].choices[0].delta.content, 'Hey');
    assert.deepEqual(getUsage(), { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
    assert.deepEqual(getPromptFilterResults(), []);
  });
});

// ---------------------------------------------------------------------------
// Content-filter errors
// ---------------------------------------------------------------------------

describe('getFoundryContentFilterError', () => {
  const results = { custom_blocklists: { details: [{ filtered: true, id: 'pizza' }], filtered: true } };

  it('reads the observed wire shape (innererror.content_filter_result)', () => {
    const err = new UpstreamError('filtered', 400, {
      error: {
        code: 'content_filter',
        message: 'filtered',
        innererror: { code: 'ResponsibleAIPolicyViolation', content_filter_result: results },
      },
    });
    assert.deepEqual(getFoundryContentFilterError(err), { message: 'filtered', results });
  });

  it('reads the spec shape (inner_error.content_filter_results)', () => {
    const err = new UpstreamError('filtered', 400, {
      error: { code: 'invalid_request', inner_error: { content_filter_results: results } },
    });
    assert.deepEqual(getFoundryContentFilterError(err), { message: 'filtered', results });
  });

  it('recognizes a filter by inner code alone', () => {
    const err = new UpstreamError('policy', 400, { error: { innererror: { code: 'ResponsibleAIPolicyViolation' } } });
    assert.deepEqual(getFoundryContentFilterError(err), { message: 'policy' });
  });

  it('recognizes the flat Model Inference shape', () => {
    const err = new UpstreamError('The response was filtered', 400, {
      status: 400,
      code: 'content_filter',
      message: 'The response was filtered',
    });
    assert.deepEqual(getFoundryContentFilterError(err), { message: 'The response was filtered' });
  });

  it('returns undefined for other errors and non-UpstreamErrors', () => {
    assert.equal(getFoundryContentFilterError(new Error('x')), undefined);
    assert.equal(getFoundryContentFilterError('x'), undefined);
    assert.equal(getFoundryContentFilterError(new UpstreamError('x', 429, { error: { code: '429' } })), undefined);
    assert.equal(getFoundryContentFilterError(new UpstreamError('x', 500, null)), undefined);
    assert.equal(getFoundryContentFilterError(new UpstreamError('x', 502, '<html/>')), undefined);
    assert.equal(getFoundryContentFilterError(new UpstreamError('x', 500)), undefined);
  });
});

describe('Foundry constants', () => {
  it('exposes api-version defaults and Entra scopes', () => {
    assert.match(FOUNDRY_DEPLOYMENTS_API_VERSION, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(FOUNDRY_MODEL_INFERENCE_API_VERSION, /-preview$/);
    assert.equal(FOUNDRY_ENTRA_SCOPE, 'https://ai.azure.com/.default');
    assert.equal(AZURE_COGNITIVE_SERVICES_SCOPE, 'https://cognitiveservices.azure.com/.default');
  });
});
