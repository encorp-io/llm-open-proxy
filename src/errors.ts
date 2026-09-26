/**
 * Thrown when an upstream provider returns a non-2xx response, or when the
 * transport itself fails (timeout, network error). `statusCode` is set from
 * the HTTP status when available; transport-level failures use the closest
 * matching code (504 for timeout, 502 for missing body).
 *
 * The full upstream response body is preserved in `upstreamBody` for
 * programmatic inspection. `toString()` and Node's `util.inspect` hook
 * both render the body inline so that `console.log(err)` and unhandled-
 * rejection output show the upstream's own explanation instead of
 * collapsing it to `[Object]`. `.message` itself stays clean (just the
 * passed-in string) — programmatic equality checks against the message
 * keep working.
 *
 * `retryAfterMs` carries the upstream's back-off hint (`retry-after-ms` or
 * `retry-after` response header) when one was sent — typically on 429/503.
 */
export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly upstreamBody: unknown = {},
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }

  override toString(): string {
    const body = formatUpstreamBody(this.upstreamBody);
    const base = `${this.name} [${this.statusCode}]: ${this.message}`;
    return body ? `${base}\nupstreamBody: ${body}` : base;
  }
}

/**
 * Pull a human-readable message out of an upstream error body. Reads the
 * common `{error: {message}}` envelope first, then a top-level `message` —
 * the shape Azure gateways use for e.g. Entra ID auth failures
 * (`{statusCode, message}`) and the Model Inference API's flat errors.
 */
export function upstreamErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const envelope = body as { error?: { message?: unknown }; message?: unknown };
  if (typeof envelope.error?.message === 'string') return envelope.error.message;
  if (typeof envelope.message === 'string') return envelope.message;
  return undefined;
}

// Node, Bun, and Deno all honor this symbol for `console.log` / util.inspect
// output. Environments without it (e.g. Cloudflare Workers' minimal console)
// silently ignore it — they get the regular Error inspection.
const NODE_INSPECT = Symbol.for('nodejs.util.inspect.custom');
Object.defineProperty(UpstreamError.prototype, NODE_INSPECT, {
  value: function inspect(this: UpstreamError): string {
    return this.toString();
  },
  writable: true,
  configurable: true,
  enumerable: false,
});

/**
 * Best-effort JSON-stringify with circular-ref guard. Returns an empty
 * string if the body is empty/null so we don't pollute the error output
 * with `"{}"` in the common transport-failure case.
 */
function formatUpstreamBody(body: unknown): string {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body || '';
  if (typeof body === 'object' && Object.keys(body as object).length === 0) return '';

  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(
      body,
      (_key, value: unknown) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        return value;
      },
      2,
    );
  } catch {
    return String(body);
  }
}
