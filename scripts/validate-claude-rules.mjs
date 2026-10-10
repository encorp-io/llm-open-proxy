#!/usr/bin/env node
/**
 * Live check of the Claude model-family rules in src/providers/anthropic.ts.
 * Costs real money (a few dollars for the default model list) and is never
 * run in CI.
 *
 *   npm run build
 *   node --env-file=.env scripts/validate-claude-rules.mjs [model ...]
 *
 * Part 1 (probes) sends raw Messages API requests to answer what each model
 * accepts: sampling controls, budget/adaptive/disabled thinking, each
 * output_config.effort level, effort + output_config.format, budget_tokens
 * >= max_tokens, sampling alongside budget thinking, forced tool_choice.
 *
 * Part 2 (matrix) translates canonical requests with the built library and
 * checks both directions:
 *   - every translated request is accepted;
 *   - every field the translator dropped or rewrote is rejected when put
 *     back the way a naive translation would send it.
 *
 * Env: ANTHROPIC_API_KEY (required). Optional Claude on Microsoft Foundry:
 * FOUNDRY_ENDPOINT + FOUNDRY_API_KEY + FOUNDRY_CLAUDE_MODELS (comma-separated
 * deployment names). Models the key cannot reach (404/403) are reported and
 * skipped. The key is never printed. VALIDATE_ANTHROPIC_URL overrides the
 * Messages endpoint (e.g. a proxy). Full results go to
 * validate-claude-rules.json in the working directory.
 */

import { writeFileSync } from 'node:fs';
import {
  toAnthropicRequest,
  streamAnthropicRequest,
  buildFoundryUrl,
  ANTHROPIC_THINKING_BUDGET,
} from '../dist/index.js';

const DEFAULT_MODELS = [
  // budget thinking + sampling controls
  'claude-haiku-4-5',
  'claude-sonnet-4-5',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  // adaptive thinking, no sampling controls
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-sonnet-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-5',
  'claude-fable-5-1',
];

const PROMPT = [{ role: 'user', content: 'Reply with the single word OK.' }];
const CONCURRENCY = 4;
const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
const TOOL = {
  name: 'get_weather',
  description: 'Weather for a city.',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

// ---------------------------------------------------------------------------
// Targets and transport
// ---------------------------------------------------------------------------

function targets(models) {
  const list = [];
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error('ANTHROPIC_API_KEY is not set (run with node --env-file=.env).');
    process.exit(2);
  }
  const url = process.env.VALIDATE_ANTHROPIC_URL ?? 'https://api.anthropic.com/v1/messages';
  for (const model of models) {
    list.push({ label: `anthropic:${model}`, model, url, key });
  }
  const { FOUNDRY_ENDPOINT, FOUNDRY_API_KEY, FOUNDRY_CLAUDE_MODELS } = process.env;
  if (FOUNDRY_ENDPOINT && FOUNDRY_API_KEY && FOUNDRY_CLAUDE_MODELS) {
    for (const model of FOUNDRY_CLAUDE_MODELS.split(',').map((m) => m.trim()).filter(Boolean)) {
      const url = buildFoundryUrl({ endpoint: FOUNDRY_ENDPOINT, api: 'anthropic' }, model);
      list.push({ label: `foundry:${model}`, model, url, key: FOUNDRY_API_KEY });
    }
  }
  return list;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(target, body) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(target.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': target.key,
        },
        body: JSON.stringify({ ...body, model: target.model }),
      });
    } catch (err) {
      if (attempt < 4) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      return { status: 0, message: String(err) };
    }
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (retryable && attempt < 4) {
      const hinted = Number(res.headers.get('retry-after')) * 1000;
      await sleep(Number.isFinite(hinted) && hinted > 0 ? hinted : 2000 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return {
      status: res.status,
      message: res.ok ? `stop_reason=${json?.stop_reason}` : (json?.error?.message ?? text.slice(0, 300)),
      unreachable: res.status === 404 || res.status === 403,
    };
  }
}

async function pool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i]);
      }
    }),
  );
  return results;
}

// ---------------------------------------------------------------------------
// Part 1 — raw probes
// ---------------------------------------------------------------------------

const PROBES = [
  ['temperature 0.5', { max_tokens: 64, temperature: 0.5 }],
  ['top_p 0.9', { max_tokens: 64, top_p: 0.9 }],
  ['top_k 40', { max_tokens: 64, top_k: 40 }],
  ['thinking enabled (budget 1024 < max_tokens 2048)', { max_tokens: 2048, thinking: { type: 'enabled', budget_tokens: 1024 } }],
  ['thinking enabled (budget 2048 = max_tokens 2048)', { max_tokens: 2048, thinking: { type: 'enabled', budget_tokens: 2048 } }],
  ['thinking enabled (budget 4096 > max_tokens 2048)', { max_tokens: 2048, thinking: { type: 'enabled', budget_tokens: 4096 } }],
  ['thinking adaptive', { max_tokens: 2048, thinking: { type: 'adaptive' } }],
  ['thinking disabled', { max_tokens: 64, thinking: { type: 'disabled' } }],
  ...['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => [
    `adaptive + effort ${effort}`,
    { max_tokens: 2048, thinking: { type: 'adaptive' }, output_config: { effort } },
  ]),
  ['effort low (thinking omitted)', { max_tokens: 2048, output_config: { effort: 'low' } }],
  ['minimal effort value', { max_tokens: 2048, thinking: { type: 'adaptive' }, output_config: { effort: 'minimal' } }],
  [
    'adaptive + effort low + output_config.format',
    { max_tokens: 2048, thinking: { type: 'adaptive' }, output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } } },
  ],
  [
    'effort low + output_config.format (thinking omitted)',
    { max_tokens: 2048, output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } } },
  ],
  ...[
    ['temperature 0.5', { temperature: 0.5 }],
    ['temperature 1', { temperature: 1 }],
    ['top_p 0.9', { top_p: 0.9 }],
    ['top_p 0.95', { top_p: 0.95 }],
    ['top_k 40', { top_k: 40 }],
  ].map(([label, extra]) => [
    `budget thinking + ${label}`,
    { max_tokens: 2048, thinking: { type: 'enabled', budget_tokens: 1024 }, ...extra },
  ]),
  ['tool_choice any', { max_tokens: 256, tools: [TOOL], tool_choice: { type: 'any' } }],
  ['tool_choice any + adaptive thinking', { max_tokens: 2048, tools: [TOOL], tool_choice: { type: 'any' }, thinking: { type: 'adaptive' } }],
  [
    'tool_choice any + budget thinking',
    { max_tokens: 2048, tools: [TOOL], tool_choice: { type: 'any' }, thinking: { type: 'enabled', budget_tokens: 1024 } },
  ],
];

// ---------------------------------------------------------------------------
// Part 2 — translation matrix
// ---------------------------------------------------------------------------

const SHAPES = [
  ['sampling controls', { temperature: 0.5, top_p: 0.9, top_k: 40, max_completion_tokens: 64 }],
  ['effort none', { reasoning_effort: 'none', max_completion_tokens: 64 }],
  ['effort minimal', { reasoning_effort: 'minimal', max_completion_tokens: 2048 }],
  ['effort low, max_tokens 2048', { reasoning_effort: 'low', max_completion_tokens: 2048 }],
  ['effort medium, max_tokens 32000', { reasoning_effort: 'medium', max_completion_tokens: 32000 }],
  ['effort high, no max_tokens', { reasoning_effort: 'high' }],
  ['effort xhigh, max_tokens 2048', { reasoning_effort: 'xhigh', max_completion_tokens: 2048 }],
  ['effort minimal, max_tokens 1024', { reasoning_effort: 'minimal', max_completion_tokens: 1024 }],
  [
    'effort low + json_schema',
    {
      reasoning_effort: 'low',
      max_completion_tokens: 2048,
      response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: SCHEMA } },
    },
  ],
  ['effort low + sampling', { reasoning_effort: 'low', max_completion_tokens: 2048, temperature: 0.5, top_p: 0.9, top_k: 40 }],
  ['effort low + temperature 1 + top_p 0.95', { reasoning_effort: 'low', max_completion_tokens: 2048, temperature: 1, top_p: 0.95 }],
  ['effort none + json_object', { reasoning_effort: 'none', max_completion_tokens: 256, response_format: { type: 'json_object' } }],
];

/**
 * What a naive translation would have sent for each field the translator
 * changed: [label, body → body]. Each one must be rejected for the change to
 * be justified.
 */
function reversals(canonical, body) {
  const out = [];
  for (const field of ['temperature', 'top_p', 'top_k']) {
    if (canonical[field] !== undefined && body[field] === undefined) {
      out.push([`re-add ${field} ${canonical[field]}`, (b) => ({ ...b, [field]: canonical[field] })]);
    }
  }
  const effort = canonical.reasoning_effort;
  if (effort && effort !== 'none') {
    const nominal = ANTHROPIC_THINKING_BUDGET[effort];
    const thinking = body.thinking;
    if (!(thinking?.type === 'enabled' && thinking.budget_tokens === nominal)) {
      out.push([
        `budget thinking ${nominal} instead of ${JSON.stringify(thinking ?? 'none')}`,
        (b) => {
          const { output_config, ...rest } = b;
          return {
            ...rest,
            thinking: { type: 'enabled', budget_tokens: nominal },
            ...(output_config?.format ? { output_config: { format: output_config.format } } : {}),
          };
        },
      ]);
    }
    if (canonical.max_completion_tokens === undefined && thinking?.type === 'enabled') {
      out.push([`old default max_tokens 4096 instead of ${body.max_tokens}`, (b) => ({ ...b, max_tokens: 4096 })]);
    }
    const sent = body.output_config?.effort;
    if (sent && sent !== effort) {
      out.push([`effort '${effort}' instead of '${sent}'`, (b) => ({ ...b, output_config: { ...b.output_config, effort } })]);
    }
  }
  if (effort === 'none' && body.output_config?.effort === 'low') {
    out.push([
      "thinking disabled instead of effort 'low'",
      (b) => {
        const { output_config, ...rest } = b;
        return {
          ...rest,
          thinking: { type: 'disabled' },
          ...(output_config?.format ? { output_config: { format: output_config.format } } : {}),
        };
      },
    ]);
  }
  return out;
}

async function streamCheck(target) {
  const body = { model: target.model, messages: PROMPT, reasoning_effort: 'low', max_completion_tokens: 2048, stream: true };
  try {
    const { stream } = await streamAnthropicRequest({ apiKey: target.key, baseUrl: target.url, body });
    const text = await new Response(stream).text();
    const content = text
      .split('\n')
      .filter((l) => l.startsWith('data: {'))
      .map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content ?? '')
      .join('');
    return { ok: content.length > 0, detail: `content=${JSON.stringify(content.slice(0, 40))}` };
  } catch (err) {
    return { ok: false, detail: String(err.message ?? err) };
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function validate(target) {
  const reach = await post(target, { messages: PROMPT, max_tokens: 16 });
  if (reach.status === 401) {
    console.error(`\nauthentication failed for ${target.label}: ${reach.message}`);
    process.exit(2);
  }
  if (reach.unreachable) return { target: target.label, skipped: reach.message };

  const probes = await pool(PROBES, async ([label, extra]) => {
    const r = await post(target, { messages: PROMPT, ...extra });
    return { label, accepted: r.status === 200, status: r.status, message: r.message };
  });

  const matrix = await pool(SHAPES, async ([label, shape]) => {
    const canonical = { model: target.model, messages: PROMPT, ...shape };
    const { request, warnings } = toAnthropicRequest(canonical);
    const sent = await post(target, { ...request, stream: false });
    const reverted = [];
    for (const [what, revert] of reversals(canonical, request)) {
      const r = await post(target, revert(request));
      reverted.push({ what, rejected: r.status === 400, status: r.status, message: r.message });
    }
    return {
      label,
      body: { ...request, messages: undefined, model: undefined },
      warnings,
      accepted: sent.status === 200,
      status: sent.status,
      message: sent.message,
      reverted,
    };
  });

  const stream = await streamCheck(target);
  return { target: target.label, probes, matrix, stream };
}

const models = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_MODELS;
const results = [];
for (const target of targets(models)) {
  process.stdout.write(`${target.label} ... `);
  const result = await validate(target);
  results.push(result);
  if (result.skipped) {
    console.log(`skipped (${result.skipped})`);
    continue;
  }
  const accepted = result.matrix.filter((m) => m.accepted).length;
  const reverts = result.matrix.flatMap((m) => m.reverted);
  const confirmed = reverts.filter((r) => r.rejected).length;
  console.log(
    `translated accepted ${accepted}/${result.matrix.length}, reversals rejected ${confirmed}/${reverts.length}, stream ${result.stream.ok ? 'ok' : 'FAILED'}`,
  );
}

console.log('\n=== Probes (raw requests; + accepted, - rejected) ===');
for (const r of results.filter((r) => !r.skipped)) {
  console.log(`\n${r.target}`);
  for (const p of r.probes) {
    console.log(`  ${p.accepted ? '+' : '-'} ${p.label}${p.accepted ? '' : `  [${p.status}] ${p.message}`}`);
  }
}

console.log('\n=== Matrix failures ===');
let failures = 0;
for (const r of results.filter((r) => !r.skipped)) {
  for (const m of r.matrix) {
    if (!m.accepted) {
      failures++;
      console.log(`  ${r.target} | ${m.label} | translated request rejected [${m.status}] ${m.message}`);
      console.log(`      sent: ${JSON.stringify(m.body)}`);
    }
    for (const rev of m.reverted.filter((x) => !x.rejected)) {
      failures++;
      console.log(`  ${r.target} | ${m.label} | change not needed: ${rev.what} was accepted [${rev.status}] ${rev.message}`);
    }
  }
  if (!r.stream.ok) {
    failures++;
    console.log(`  ${r.target} | stream | ${r.stream.detail}`);
  }
}
if (failures === 0) console.log('  none');

writeFileSync('validate-claude-rules.json', `${JSON.stringify(results, null, 2)}\n`);
console.log('\nFull results: validate-claude-rules.json');
process.exitCode = failures === 0 ? 0 : 1;
