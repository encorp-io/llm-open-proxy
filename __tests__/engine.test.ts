import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { transformChatRequest, type ProviderParamConfig } from '../src/engine.js';
import type { CanonicalChatRequest } from '../src/types.js';

const baseReq: CanonicalChatRequest = {
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('transformChatRequest — action kinds', () => {
  it('passthrough copies the field as-is', () => {
    const cfg: ProviderParamConfig = { temperature: { kind: 'passthrough' } };
    const { body, warnings } = transformChatRequest(
      { ...baseReq, temperature: 0.7 },
      cfg,
      'openai',
    );
    assert.equal(body.temperature, 0.7);
    assert.deepEqual(warnings, []);
  });

  it('rename moves the value to a new key', () => {
    const cfg: ProviderParamConfig = { stop: { kind: 'rename', to: 'stop_sequences' } };
    const { body } = transformChatRequest(
      { ...baseReq, stop: ['END'] },
      cfg,
      'anthropic',
    );
    assert.deepEqual(body.stop_sequences, ['END']);
    assert.equal(body.stop, undefined);
  });

  it('rename with transform runs the transform', () => {
    const cfg: ProviderParamConfig = {
      temperature: { kind: 'rename', to: 'temp_x10', transform: (v) => Number(v) * 10 },
    };
    const { body } = transformChatRequest({ ...baseReq, temperature: 0.5 }, cfg, 'openai');
    assert.equal(body.temp_x10, 5);
  });

  it('rename with transform returning undefined drops the field', () => {
    const cfg: ProviderParamConfig = {
      temperature: { kind: 'rename', to: 'x', transform: () => undefined },
    };
    const { body } = transformChatRequest({ ...baseReq, temperature: 0.5 }, cfg, 'openai');
    assert.equal(body.x, undefined);
  });

  it('nest places the value at a dotted path, creating intermediate objects', () => {
    const cfg: ProviderParamConfig = {
      temperature: { kind: 'nest', path: 'sampling.params.temperature' },
    };
    const { body } = transformChatRequest({ ...baseReq, temperature: 0.5 }, cfg, 'openai');
    assert.deepEqual(body.sampling, { params: { temperature: 0.5 } });
  });

  it('nest reuses an existing object on the path', () => {
    const cfg: ProviderParamConfig = {
      temperature: { kind: 'nest', path: 'cfg.temp' },
      top_p: { kind: 'nest', path: 'cfg.top_p' },
    };
    const { body } = transformChatRequest(
      { ...baseReq, temperature: 0.5, top_p: 0.9 },
      cfg,
      'openai',
    );
    assert.deepEqual(body.cfg, { temp: 0.5, top_p: 0.9 });
  });

  it('nest overwrites a non-object value already on the path', () => {
    const cfg: ProviderParamConfig = {
      seed: {
        kind: 'custom',
        apply(body) {
          body.cfg = 'string-not-object';
        },
      },
      temperature: { kind: 'nest', path: 'cfg.temp' },
    };
    const { body } = transformChatRequest(
      { ...baseReq, seed: 1, temperature: 0.5 },
      cfg,
      'openai',
    );
    assert.deepEqual(body.cfg, { temp: 0.5 });
  });

  it('nest with transform applies the transform; undefined drops the value', () => {
    const cfg: ProviderParamConfig = {
      temperature: { kind: 'nest', path: 'a.b', transform: () => undefined },
    };
    const { body } = transformChatRequest({ ...baseReq, temperature: 0.5 }, cfg, 'openai');
    assert.equal(body.a, undefined);
  });

  it('nest with transform applies the transform; non-undefined value is set', () => {
    const cfg: ProviderParamConfig = {
      temperature: { kind: 'nest', path: 'a.b', transform: (v) => Number(v) + 1 },
    };
    const { body } = transformChatRequest({ ...baseReq, temperature: 0.5 }, cfg, 'openai');
    assert.deepEqual(body.a, { b: 1.5 });
  });

  it('drop emits a warning and omits the field', () => {
    const cfg: ProviderParamConfig = {
      temperature: { kind: 'drop', reason: 'unsupported' },
    };
    const { body, warnings } = transformChatRequest(
      { ...baseReq, temperature: 0.5 },
      cfg,
      'openai',
    );
    assert.equal(body.temperature, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /'temperature' dropped for openai: unsupported/);
  });

  it('custom delegates to the apply callback', () => {
    const cfg: ProviderParamConfig = {
      temperature: {
        kind: 'custom',
        apply(body, value) {
          body.t = `<${value}>`;
        },
      },
    };
    const { body } = transformChatRequest({ ...baseReq, temperature: 0.5 }, cfg, 'openai');
    assert.equal(body.t, '<0.5>');
  });

  it('always fires once even when the canonical field is absent', () => {
    let callCount = 0;
    const cfg: ProviderParamConfig = {
      max_tokens: {
        kind: 'always',
        apply(body, value) {
          callCount++;
          body.max_tokens = value ?? 4096;
        },
      },
    };
    const { body } = transformChatRequest(baseReq, cfg, 'anthropic');
    assert.equal(callCount, 1);
    assert.equal(body.max_tokens, 4096);
  });

  it('always fires once even when canonical field is present (only via the seen-key first pass)', () => {
    let callCount = 0;
    const cfg: ProviderParamConfig = {
      max_tokens: {
        kind: 'always',
        apply(body, value) {
          callCount++;
          body.max_tokens = (value as number) ?? 4096;
        },
      },
    };
    const { body } = transformChatRequest({ ...baseReq, max_tokens: 256 }, cfg, 'anthropic');
    assert.equal(callCount, 1);
    assert.equal(body.max_tokens, 256);
  });
});

describe('transformChatRequest — passthroughs and special keys', () => {
  it('always copies model and messages onto the body', () => {
    const { body } = transformChatRequest(baseReq, {}, 'openai');
    assert.equal(body.model, 'm');
    assert.deepEqual(body.messages, baseReq.messages);
  });

  it('skips messages and model even when the config declares them', () => {
    const cfg: ProviderParamConfig = {};
    const { body, warnings } = transformChatRequest(baseReq, cfg, 'openai');
    assert.deepEqual(warnings, []);
    assert.equal(body.model, 'm');
  });

  it('skips provider_options as a regular field; matching entry merges into body', () => {
    const cfg: ProviderParamConfig = {};
    const { body, warnings } = transformChatRequest(
      {
        ...baseReq,
        provider_options: {
          openai: { custom_a: 1, custom_b: 'x', undef: undefined },
          anthropic: { ignored: 9 },
        },
      },
      cfg,
      'openai',
    );
    assert.equal(body.custom_a, 1);
    assert.equal(body.custom_b, 'x');
    assert.equal(body.ignored, undefined);
    assert.equal(body.undef, undefined);
    assert.deepEqual(warnings, []);
  });

  it('omits provider_options merge when no entry matches the active provider', () => {
    const { body } = transformChatRequest(
      { ...baseReq, provider_options: { anthropic: { x: 1 } } },
      {},
      'openai',
    );
    assert.equal(body.x, undefined);
  });

  it('drops unknown fields with a warning', () => {
    const { warnings } = transformChatRequest(
      { ...baseReq, top_k: 40 },
      {}, // empty config
      'openai',
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /'top_k' is not supported by openai -- dropped/);
  });

  it('skips undefined canonical fields silently', () => {
    const cfg: ProviderParamConfig = { temperature: { kind: 'passthrough' } };
    const { body, warnings } = transformChatRequest(
      { ...baseReq, temperature: undefined },
      cfg,
      'openai',
    );
    assert.equal(body.temperature, undefined);
    assert.deepEqual(warnings, []);
  });
});
