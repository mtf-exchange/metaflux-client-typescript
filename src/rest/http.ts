// Thin fetch wrapper used by the Client class.
//
// All HTTP logic is intentionally pure-TS — the WASM module is for
// crypto + canonical encoding only. The wrapper centralises three
// concerns: (a) base-URL composition, (b) JWT bearer header (when the
// caller has authenticated), and (c) translating the gateway's CCXT-
// compat error envelope `{ "error": "..." }` into a typed exception.

import type { ErrorEnvelope } from '../types/index.js';

/// Thrown when the gateway responds with a non-2xx status. Carries the
/// status code + the message extracted from `{ "error": "..." }` (or
/// the raw body if the response was not JSON).
export class MetaFluxApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
    message: string,
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

/// Single fetch wrapper everything routes through.
///
/// Concatenates `baseUrl + path`, applies the query string, sets headers
/// + body, awaits the response, and either:
/// - returns the parsed JSON (when the response is 2xx + JSON), or
/// - returns the raw `Response` (when the caller passed `rawResponse`),
///   or
/// - throws `MetaFluxApiError` (non-2xx).
export async function httpRequest<T>(
  baseUrl: string,
  path: string,
  init: HttpRequestInit = {},
): Promise<T> {
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

  // Read body once — fetch's body is single-use.
  const text = await res.text();
  if (!res.ok) {
    const msg = extractErrorMessage(text);
    throw new MetaFluxApiError(res.status, text, msg);
  }
  if (text.length === 0) {
    // 204 / empty body — caller asked for a `T`, return undefined cast.
    // The Client never relies on this path; documented here so an
    // accidental schema change surfaces as a runtime cast failure.
    return undefined as unknown as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new MetaFluxApiError(
      res.status,
      text,
      'response was not valid JSON',
    );
  }
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

/// Extract the `error` field from a CCXT-compat error envelope. Falls
/// back to the raw text if parsing fails.
function extractErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as Partial<ErrorEnvelope>;
    if (typeof parsed.error === 'string' && parsed.error.length > 0) {
      return parsed.error;
    }
  } catch {
    // Fall through.
  }
  // Truncate to keep stack traces readable.
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
