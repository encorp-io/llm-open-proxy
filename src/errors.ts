/**
 * Thrown when an upstream provider returns a non-2xx response, or when the
 * transport itself fails (timeout, network error). `statusCode` is set from
 * the HTTP status when available; transport-level failures use the closest
 * matching code (504 for timeout, 502 for missing body).
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
}
