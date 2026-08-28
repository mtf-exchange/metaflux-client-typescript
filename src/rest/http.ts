// Thin fetch wrapper used by the Client class.
//
// All HTTP logic is intentionally pure-TS — the WASM module is for
// crypto + canonical encoding only. The wrapper centralises three
// concerns: (a) base-URL composition, (b) JWT bearer header (when the
// caller has authenticated), and (c) turning a rejection into a typed
// exception.
//
// Two entry points, because two body shapes exist:
// - `envelopeRequest` — `/info` and `/exchange`. Unwraps the `{data}` success
//   envelope and raises the `{error}` failure envelope.
// - `httpRequest` — every other route (today the faucet). Returns the parsed
//   body verbatim and raises on a non-2xx status.

import type {
  ApiError,
  ApiErrorCode,
  ApiErrorDetails,
  ErrorEnvelope,
} from '../types/index.js';

/// Thrown when a request is rejected.
///
/// `code` is the stable contract — branch on it. `message` is prose and MAY
/// change in any release, so never match on it. `details` carries the violated
/// bound and is `undefined` when the rejection names none.
///
/// `code` and `details` are `undefined` when the response carried no error
/// envelope — a proxy 502, an unparseable body, or the faucet's prose-only
/// `{ "error": "..." }`.
///
/// A COMMIT-time rejection answers HTTP `200`, so this is thrown on 2xx too.
/// Read `status` for what the transport said and `code` for what the node said.
export class MetaFluxApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
    message: string,
    public readonly code?: ApiErrorCode,
    public readonly details?: ApiErrorDetails,
  ) {
    super(`MetaFlux gateway error ${status}: ${message}`);
    this.name = 'MetaFluxApiError';
  }
}

/// Internal fetch options accepted by `httpRequest`. Mirrors a subset
/// of the standard `RequestInit` plus auth-aware fields.
export interface HttpRequestInit {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /// Object that will be `JSON.stringify`-d into the body. Sets
  /// `Content-Type: application/json` automatically.
  json?: unknown;
  /// Raw `Uint8Array` body — `Content-Type` defaults to
  /// `application/octet-stream` unless overridden. Used by the
  /// signed-action POST surface that carries msgpack bytes.
  bytes?: Uint8Array;
  /// Pre-serialized JSON STRING body — sent verbatim (not re-stringified).
  /// `Content-Type` defaults to `application/json`. Used by the MTF-native
  /// signed-action path, where the `action` field MUST carry the exact bytes
  /// that were signed (the server verifies over `serde_json::RawValue`); a
  /// `JSON.parse`→`JSON.stringify` round-trip would risk reordering / spacing
  /// drift and break every signature.
  rawJson?: string;
  /// JWT bearer token (gateway-issued; persisted by the Client class
  /// after `/auth`). Adds `Authorization: Bearer <jwt>`.
  bearer?: string;
  /// Override / supplement headers.
  headers?: Record<string, string>;
  /// Query-string params. Strings only (`number` -> `String(n)` at
  /// call site so we don't accidentally serialise NaN).
  query?: Record<string, string>;
  /// AbortSignal for cancellation. Useful for the WebSocket-style
  /// long-polling routes the Client adds in later phases.
  signal?: AbortSignal;
}

/// Single fetch wrapper everything routes through. Returns the status and the
/// body text; the body is read once, because fetch's body is single-use.
async function send(
  baseUrl: string,
  path: string,
  init: HttpRequestInit,
): Promise<{ status: number; ok: boolean; text: string }> {
  const url = buildUrl(baseUrl, path, init.query);
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: BodyInit | undefined;

  if (init.rawJson !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    body = init.rawJson;
  } else if (init.json !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.bytes !== undefined) {
    headers['Content-Type'] =
      headers['Content-Type'] ?? 'application/octet-stream';
    // Re-allocate to a fresh ArrayBuffer slice so a shared/transferred
    // buffer can't be mutated underneath fetch.
    const fresh = new Uint8Array(init.bytes);
    body = fresh;
  }
  if (init.bearer !== undefined) {
    headers['Authorization'] = `Bearer ${init.bearer}`;
  }

  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    body,
    signal: init.signal,
  });
  return { status: res.status, ok: res.ok, text: await res.text() };
}

/// Request a route that answers the shared envelope (`/info`, `/exchange`).
///
/// Returns the unwrapped `data` on a success and throws `MetaFluxApiError` on a
/// failure. The presence of `error` decides, NOT the HTTP status: a rejection at
/// commit time answers `200` with an `error` body, so a status-only test would
/// read it as a success.
export async function envelopeRequest<T>(
  baseUrl: string,
  path: string,
  init: HttpRequestInit = {},
): Promise<T> {
  const { status, ok, text } = await send(baseUrl, path, init);
  const body = parseJson(text);

  if (isRecord(body) && 'error' in body) {
    const e = asApiError(body.error);
    throw new MetaFluxApiError(status, text, e.message, e.code, e.details);
  }
  if (!ok) {
    throw new MetaFluxApiError(status, text, truncate(text));
  }
  if (body === undefined) {
    throw new MetaFluxApiError(status, text, 'response was not valid JSON');
  }
  if (!isRecord(body) || !('data' in body)) {
    throw new MetaFluxApiError(
      status,
      text,
      'response is not a {data} envelope',
    );
  }
  // `data` may legitimately be null — a read can succeed with no content.
  return body.data as T;
}

/// Request a route that answers a bare body (today the faucet). Returns the
/// parsed JSON on 2xx and throws `MetaFluxApiError` otherwise.
export async function httpRequest<T>(
  baseUrl: string,
  path: string,
  init: HttpRequestInit = {},
): Promise<T> {
  const { status, ok, text } = await send(baseUrl, path, init);
  if (!ok) {
    throw new MetaFluxApiError(status, text, extractErrorMessage(text));
  }
  if (text.length === 0) {
    // 204 / empty body — caller asked for a `T`, return undefined cast.
    // The Client never relies on this path; documented here so an
    // accidental schema change surfaces as a runtime cast failure.
    return undefined as unknown as T;
  }
  const body = parseJson(text);
  if (body === undefined) {
    throw new MetaFluxApiError(status, text, 'response was not valid JSON');
  }
  return body as T;
}

/// URL builder. Tolerates `baseUrl` with or without a trailing slash and
/// `path` with or without a leading slash; never doubles either.
function buildUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string> | undefined,
): string {
  const trimmedBase = baseUrl.endsWith('/')
    ? baseUrl.slice(0, -1)
    : baseUrl;
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  const joined = `${trimmedBase}${trimmedPath}`;
  if (query === undefined || Object.keys(query).length === 0) {
    return joined;
  }
  const qs = new URLSearchParams(query).toString();
  return `${joined}?${qs}`;
}

/// Parse a body, or `undefined` when it is not JSON.
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/// Read the envelope's `error` half. A pre-envelope node answers a bare string
/// there, so that degrades to a message with no `code` instead of throwing.
function asApiError(raw: unknown): Partial<ApiError> & { message: string } {
  if (isRecord(raw) && typeof raw.message === 'string') {
    return {
      code: typeof raw.code === 'string' ? raw.code : undefined,
      message: raw.message,
      details: isRecord(raw.details)
        ? (raw.details as unknown as ApiErrorDetails)
        : undefined,
    };
  }
  return { message: typeof raw === 'string' ? raw : truncate(String(raw)) };
}

/// Extract the `error` field from the faucet's prose-only error body. Falls
/// back to the raw text if parsing fails.
function extractErrorMessage(text: string): string {
  const parsed = parseJson(text) as Partial<ErrorEnvelope> | undefined;
  if (typeof parsed?.error === 'string' && parsed.error.length > 0) {
    return parsed.error;
  }
  return truncate(text);
}

/// Truncate to keep stack traces readable.
function truncate(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
