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
 */
export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly upstreamBody: unknown = {},
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
