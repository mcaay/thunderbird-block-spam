// HTTP helpers shared by the access point adapters: timeout, error classification
// and messages that never contain secrets.

import { AccessPointError, MAX_COOLDOWN_MS, REQUEST_TIMEOUT_MS } from "../core/chain";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const ERROR_MESSAGE_LIMIT = 300;

/** Removes secrets from a message and shortens it. */
export function safeMessage(message: string, secrets: readonly string[] = []): string {
  let text = message;
  for (const secret of secrets) {
    if (secret !== "") {
      text = text.split(secret).join("***");
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > ERROR_MESSAGE_LIMIT ? `${text.slice(0, ERROR_MESSAGE_LIMIT)}...` : text;
}

/**
 * Retry-After as milliseconds from now: a number of seconds or an HTTP date, at
 * least a second and at most a day. Null when absent or invalid.
 */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null || value.trim() === "") {
    return null;
  }
  const seconds = Number(value);
  const wait = Number.isFinite(seconds) ? (seconds >= 0 ? seconds * 1000 : Number.NaN) : Date.parse(value) - now;
  if (Number.isNaN(wait)) {
    return null;
  }
  // A huge number of seconds overflows to Infinity, which could not be stored.
  return Math.min(MAX_COOLDOWN_MS, Math.max(1000, Math.round(wait)));
}

/** Finds a human-readable error message in the JSON bodies the supported providers return. */
export function errorMessageFromBody(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  if (typeof body !== "object" || body === null) {
    return "";
  }
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (typeof error === "string") {
    const description = record.error_description;
    return typeof description === "string" ? `${error}: ${description}` : error;
  }
  if (typeof error === "object" && error !== null) {
    const inner = error as Record<string, unknown>;
    const parts = [inner.code, inner.type, inner.message].filter((part) => typeof part === "string" && part !== "");
    if (parts.length > 0) {
      return [...new Set(parts)].join(": ");
    }
  }
  if (typeof record.detail === "string") {
    return record.detail;
  }
  if (record.detail !== undefined) {
    return JSON.stringify(record.detail);
  }
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    const first = record.errors[0] as Record<string, unknown> | string;
    return typeof first === "string" ? first : String(first?.message ?? JSON.stringify(first));
  }
  if (typeof record.message === "string") {
    return record.message;
  }
  return "";
}

/** The machine-readable error code of a JSON error body, or "". */
export function errorCodeFromBody(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    return "";
  }
  const record = body as Record<string, unknown>;
  if (typeof record.error === "string") {
    return record.error;
  }
  if (typeof record.error === "object" && record.error !== null) {
    const inner = record.error as Record<string, unknown>;
    if (typeof inner.code === "string") {
      return inner.code;
    }
    if (typeof inner.type === "string") {
      return inner.type;
    }
  }
  return "";
}

/**
 * Maps an HTTP error status to a chain failure (design section 8.2):
 * 401 and 403 need attention, 429 and 402 are quota errors, everything else moves on.
 */
export function statusError(
  status: number,
  body: unknown,
  retryAfter: string | null,
  now: number,
  secrets: readonly string[] = [],
): AccessPointError {
  const text = safeMessage(errorMessageFromBody(body), secrets);
  const message = text === "" ? `HTTP ${status}` : `HTTP ${status}: ${text}`;
  if (status === 401 || status === 403) {
    return new AccessPointError("auth", message);
  }
  if (status === 429 || status === 402) {
    return new AccessPointError("quota", message, parseRetryAfter(retryAfter, now));
  }
  return new AccessPointError("transient", message);
}

export interface HttpResult {
  status: number;
  ok: boolean;
  /** Parsed JSON, or the raw text when the body is not JSON. */
  body: unknown;
  retryAfter: string | null;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Sends a request and reads the whole response within the timeout. Network errors
 * and timeouts become transient failures.
 */
export async function request(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<HttpResult> {
  return withTimeout(timeoutMs, async (signal) => {
    const response = await fetchFn(url, { ...init, signal });
    return {
      status: response.status,
      ok: response.ok,
      body: await readBody(response),
      retryAfter: response.headers.get("retry-after"),
    };
  });
}

/** Runs an operation with an abort signal that fires after the timeout. */
export async function withTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (error instanceof AccessPointError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new AccessPointError("transient", `no answer within ${Math.round(timeoutMs / 1000)} seconds`);
    }
    throw new AccessPointError("transient", `network error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A POST carries the mail payload or a token. A redirect would send it again to an
 * address that was never checked against the https rule, the consent or the host
 * permission, so it fails as a network error instead.
 */
export const NO_REDIRECT: RequestRedirect = "error";

export function postJson(
  fetchFn: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs?: number,
): Promise<HttpResult> {
  return request(
    fetchFn,
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: NO_REDIRECT,
    },
    timeoutMs,
  );
}

export function postForm(
  fetchFn: FetchLike,
  url: string,
  fields: Record<string, string>,
  timeoutMs?: number,
): Promise<HttpResult> {
  return request(
    fetchFn,
    url,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(fields).toString(),
      redirect: NO_REDIRECT,
    },
    timeoutMs,
  );
}

/** Endpoints on loopback addresses may use http. All others must use https. */
export function validateEndpoint(raw: string): { ok: true; url: URL } | { ok: false; reason: "invalid" | "insecure" } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol === "https:") {
    return { ok: true, url };
  }
  if (url.protocol === "http:") {
    return isLoopbackHost(url.hostname) ? { ok: true, url } : { ok: false, reason: "insecure" };
  }
  return { ok: false, reason: "invalid" };
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/** The host permission pattern for an endpoint, for example https://api.openai.com/*. */
export function originPattern(url: URL): string {
  return `${url.protocol}//${url.hostname}/*`;
}
