/**
 * Declarative parameter-mapping engine.
 *
 * Each provider declares, per canonical field, how that field should be
 * forwarded: passthrough, rename, nest, drop, or run a custom function. The
 * engine walks the canonical request, applies the per-field action, and
 * returns the provider-specific body plus a list of warnings (dropped or
 * transformed fields).
 *
 * Reference for the declarative pattern: Portkey AI Gateway
 * (https://github.com/Portkey-AI/gateway, MIT).
 */

import type { CanonicalChatRequest, ProviderName } from './types.js';

export interface TransformCtx {
  provider: ProviderName;
  fullRequest: CanonicalChatRequest;
  warn: (msg: string) => void;
}

export type MapAction =
  | { kind: 'passthrough' }
  | { kind: 'rename'; to: string; transform?: (v: unknown, ctx: TransformCtx) => unknown }
  | { kind: 'nest'; path: string; transform?: (v: unknown, ctx: TransformCtx) => unknown }
  | { kind: 'drop'; reason: string }
  | { kind: 'custom'; apply: (body: Record<string, unknown>, value: unknown, ctx: TransformCtx) => void }
  /**
   * Runs even when the canonical field is absent. Use for fields that have
   * provider-mandated defaults (e.g. Anthropic requires `max_tokens`).
   */
  | { kind: 'always'; apply: (body: Record<string, unknown>, value: unknown, ctx: TransformCtx) => void };

/**
 * Per-provider mapping table. Keys are canonical-request fields. A field
 * present in the canonical request but absent from the config is dropped
 * with a warning (strict mode — protects against unknown-field rejections).
 *
 * `messages` and `model` are intentionally not handled here — adapters
 * reshape messages themselves because the structure is provider-specific.
 */
export type ProviderParamConfig = Partial<Record<keyof CanonicalChatRequest, MapAction>>;

export interface TransformResult {
  body: Record<string, unknown>;
  warnings: string[];
}

/**
 * Transform a canonical request into a provider-specific body using the
 * supplied config. Pure function — no I/O.
 *
 * - `messages` and `model` are copied to the output as-is. Adapters that
 *   need to reshape messages (Anthropic, etc.) should overwrite the
 *   resulting `messages` and `system` fields after calling this.
 * - `provider_options` is special: only the entry matching the active
 *   provider is shallow-merged into the body verbatim; other entries are
 *   silently ignored.
 * - Unknown fields (present on canonical but absent from the config) emit
 *   a warning and are dropped.
 */
export function transformChatRequest(
  canonical: CanonicalChatRequest,
  config: ProviderParamConfig,
  provider: ProviderName,
): TransformResult {
  const body: Record<string, unknown> = {};
  const warnings: string[] = [];
  const ctx: TransformCtx = {
    provider,
    fullRequest: canonical,
    warn: (msg) => warnings.push(msg),
  };

  const seen = new Set<string>();
  for (const key of Object.keys(canonical) as Array<keyof CanonicalChatRequest>) {
    const value = canonical[key];
    if (value === undefined) continue;
    if (key === 'messages' || key === 'model') continue;
    if (key === 'provider_options') continue;

    const action = config[key];
    if (!action) {
      warnings.push(`'${String(key)}' is not supported by ${provider} -- dropped`);
      continue;
    }
    applyAction(body, String(key), value, action, ctx);
    seen.add(String(key));
  }

  // Run any `always` actions for fields that weren't on canonical, so
  // provider-mandated defaults (e.g. Anthropic max_tokens) still fire.
  for (const [key, action] of Object.entries(config)) {
    if (seen.has(key)) continue;
    if (!action || action.kind !== 'always') continue;
    applyAction(body, key, undefined, action, ctx);
  }

  body.model = canonical.model;
  body.messages = canonical.messages;

  const providerOpts = canonical.provider_options?.[provider];
  if (providerOpts && typeof providerOpts === 'object') {
    for (const [k, v] of Object.entries(providerOpts)) {
      if (v !== undefined) body[k] = v;
    }
  }

  return { body, warnings };
}

function applyAction(
  body: Record<string, unknown>,
  key: string,
  value: unknown,
  action: MapAction,
  ctx: TransformCtx,
): void {
  switch (action.kind) {
    case 'passthrough':
      body[key] = value;
      return;
    case 'rename': {
      const next = action.transform ? action.transform(value, ctx) : value;
      if (next !== undefined) body[action.to] = next;
      return;
    }
    case 'nest': {
      const next = action.transform ? action.transform(value, ctx) : value;
      if (next === undefined) return;
      setByPath(body, action.path, next);
      return;
    }
    case 'drop':
      ctx.warn(`'${key}' dropped for ${ctx.provider}: ${action.reason}`);
      return;
    case 'custom':
      action.apply(body, value, ctx);
      return;
    case 'always':
      action.apply(body, value, ctx);
      return;
  }
}

function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    const existing = cursor[p];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      cursor = existing as Record<string, unknown>;
    } else {
      const next: Record<string, unknown> = {};
      cursor[p] = next;
      cursor = next;
    }
  }
  cursor[parts[parts.length - 1]] = value;
}
