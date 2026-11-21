// "Sign in with ChatGPT" plan usage for open-source local apps: authorization code
// flow with PKCE and a dynamically registered client.
//
// Follows https://developers.openai.com/siwc/token-sharing-open-source and its
// sign-in, accounts-and-sessions and token-reference pages.

import { AccessPointError } from "../core/chain";
import type { ChatGptAuth } from "../core/types";
import { errorCodeFromBody, errorMessageFromBody, postForm, request, safeMessage } from "./http";
import type { FetchLike } from "./http";

export const ISSUER = "https://auth.openai.com";
export const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
export const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
export const JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
export const DISCOVERY_URL = "https://auth.openai.com/.well-known/openid-configuration";
export const RESOURCE = "https://api.openai.com/v1";
export const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
export const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
/** The first-time registration entry point. Never saved and never used for a token exchange. */
export const REGISTRATION_CLIENT_ID = "dynamic_agent_client";
export const AGENT_NAME = "Block Spam";
export const USAGE_URL = "https://chatgpt.com/settings/usage";

/** How long a started sign-in stays valid. */
export const SIGN_IN_TIMEOUT_MS = 15 * 60 * 1000;
const CLOCK_SKEW_MS = 5000;
/** Refresh this long before the access token expires. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type SignInErrorCode =
  | "state-mismatch"
  | "wrong-address"
  | "denied"
  | "provider-error"
  | "no-code"
  | "registration-incomplete"
  | "client-mismatch"
  | "exchange-failed"
  | "invalid-token"
  | "account-mismatch"
  | "plan-not-enabled";

/** A failed sign-in. The code is translated for the user; the detail comes from the provider. */
export class SignInError extends Error {
  readonly code: SignInErrorCode;
  readonly detail: string;

  constructor(code: SignInErrorCode, detail = "") {
    super(detail === "" ? code : `${code}: ${detail}`);
    this.name = "SignInError";
    this.code = code;
    this.detail = detail;
  }
}

/** Everything about one authorization attempt that must survive until the callback. */
export interface PendingSignIn {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  /** Issued client id of a returning account. Null for a new registration. */
  clientId: string | null;
  /** Subject of the returning account. The new ID token must match it. */
  expectedSubject: string | null;
  /** Access point being signed in again. Null when a new one is created. */
  accessPointId: string | null;
  startedAt: number;
  /** Thunderbird tab showing the authorization page, when one was opened. */
  tabId: number | null;
}

export interface ReturningAccount {
  clientId: string;
  subject: string;
  email: string;
  /** Retained ID token, sent as id_token_hint. Empty after signing out. */
  idToken: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/**
 * Starts an authorization attempt with fresh state, nonce and PKCE values. A new
 * account registers through dynamic_agent_client; a returning account reuses its
 * issued client id and sends no agent name.
 */
export async function beginSignIn(options: {
  hostId: string;
  returning: ReturningAccount | null;
  accessPointId: string | null;
  now: number;
}): Promise<{ url: string; pending: PendingSignIn }> {
  const pending: PendingSignIn = {
    state: randomToken(),
    nonce: randomToken(),
    verifier: randomToken(),
    redirectUri: REDIRECT_URI,
    clientId: options.returning?.clientId ?? null,
    expectedSubject: options.returning?.subject ?? null,
    accessPointId: options.accessPointId,
    startedAt: options.now,
    tabId: null,
  };
  const params = new URLSearchParams();
  if (options.returning === null) {
    params.set("client_id", REGISTRATION_CLIENT_ID);
    params.set("agent_name_hint", AGENT_NAME);
  } else {
    params.set("client_id", options.returning.clientId);
    if (options.returning.idToken !== "") {
      params.set("id_token_hint", options.returning.idToken);
    }
    if (options.returning.email !== "") {
      params.set("login_hint", options.returning.email);
    }
  }
  params.set("ext_agent_host_id", options.hostId);
  params.set("response_type", "code");
  params.set("redirect_uri", pending.redirectUri);
  params.set("scope", SCOPES);
  params.set("resource", RESOURCE);
  params.set("state", pending.state);
  params.set("nonce", pending.nonce);
  params.set("code_challenge_method", "S256");
  params.set("code_challenge", await pkceChallenge(pending.verifier));
  return { url: `${AUTHORIZE_URL}?${params.toString()}`, pending };
}

/** True when a URL is the loopback callback of this attempt, whatever its query. */
export function isCallbackUrl(candidate: string, pending: PendingSignIn): boolean {
  try {
    const url = new URL(candidate);
    const expected = new URL(pending.redirectUri);
    return url.origin === expected.origin && url.pathname === expected.pathname;
  } catch {
    return false;
  }
}

/**
 * Validates the callback and returns the authorization code with the client id to
 * use for the exchange. The state is checked before anything else is trusted.
 */
export function parseCallback(callbackUrl: string, pending: PendingSignIn): { code: string; clientId: string } {
  if (!isCallbackUrl(callbackUrl.trim(), pending)) {
    throw new SignInError("wrong-address");
  }
  const params = new URL(callbackUrl.trim()).searchParams;
  if (params.get("state") !== pending.state) {
    throw new SignInError("state-mismatch");
  }
  const error = params.get("error");
  if (error !== null) {
    if (error === "access_denied") {
      throw new SignInError("denied");
    }
    throw new SignInError("provider-error", safeMessage(`${error} ${params.get("error_description") ?? ""}`));
  }
  const code = params.get("code");
  if (code === null || code === "") {
    throw new SignInError("no-code");
  }
  const issued = params.get("client_id");
  if (pending.clientId === null) {
    if (issued === null || issued === "" || issued === REGISTRATION_CLIENT_ID) {
      throw new SignInError("registration-incomplete");
    }
    return { code, clientId: issued };
  }
  if (issued !== null && issued !== pending.clientId) {
    throw new SignInError("client-mismatch");
  }
  return { code, clientId: pending.clientId };
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresIn: number;
  scopes: string[];
  earliestRefreshAt: number;
}

function readTokenResponse(body: unknown): TokenResponse | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.access_token !== "string" || record.access_token === "") {
    return null;
  }
  const expiresIn = typeof record.expires_in === "number" && record.expires_in > 0 ? record.expires_in : 3600;
  return {
    accessToken: record.access_token,
    refreshToken: typeof record.refresh_token === "string" ? record.refresh_token : "",
    idToken: typeof record.id_token === "string" ? record.id_token : "",
    expiresIn,
    scopes: typeof record.scope === "string" ? record.scope.split(/\s+/).filter((scope) => scope !== "") : [],
    earliestRefreshAt: readTimestamp(record.earliest_refresh_at),
  };
}

/** Accepts Unix seconds, epoch milliseconds or a date string. Returns epoch milliseconds, 0 when absent. */
function readTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value === "string" && value !== "") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return readTimestamp(numeric);
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  [name: string]: unknown;
}

function decodeJson(part: string): Record<string, unknown> {
  const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("not an object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Verifies the ID token: signature against the published JWKS, issuer, audience
 * (the issued client id), expiry and the nonce of this attempt. Returns the
 * validated subject and the email claim.
 */
export async function verifyIdToken(
  fetchFn: FetchLike,
  idToken: string,
  expected: { clientId: string; nonce: string; now: number },
): Promise<{ subject: string; email: string }> {
  const invalid = (why: string): SignInError => new SignInError("invalid-token", why);
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw invalid("wrong format");
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeJson(headerPart);
    payload = decodeJson(payloadPart);
  } catch {
    throw invalid("it cannot be decoded");
  }

  const algorithm =
    header.alg === "RS256"
      ? { importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verifyParams: { name: "RSASSA-PKCS1-v1_5" } }
      : header.alg === "ES256"
        ? { importParams: { name: "ECDSA", namedCurve: "P-256" }, verifyParams: { name: "ECDSA", hash: "SHA-256" } }
        : null;
  if (algorithm === null) {
    throw invalid("unsupported signature algorithm");
  }

  const jwks = await request(fetchFn, JWKS_URL, { method: "GET", headers: { accept: "application/json" } });
  const keys = (jwks.ok && typeof jwks.body === "object" && jwks.body !== null
    ? (jwks.body as { keys?: unknown }).keys
    : null) as Jwk[] | null;
  if (!Array.isArray(keys)) {
    throw invalid("the signing keys could not be loaded");
  }
  const candidates = keys.filter((key) => (typeof header.kid === "string" ? key.kid === header.kid : true));
  let verified = false;
  for (const jwk of candidates) {
    try {
      const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, algorithm.importParams, false, ["verify"]);
      verified = await crypto.subtle.verify(
        algorithm.verifyParams,
        key,
        base64UrlDecode(signaturePart),
        new TextEncoder().encode(`${headerPart}.${payloadPart}`),
      );
    } catch {
      verified = false;
    }
    if (verified) {
      break;
    }
  }
  if (!verified) {
    throw invalid("the signature does not match");
  }

  if (payload.iss !== ISSUER) {
    throw invalid("wrong issuer");
  }
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audience.includes(expected.clientId)) {
    throw invalid("wrong audience");
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 < expected.now - CLOCK_SKEW_MS) {
    throw invalid("it has expired");
  }
  if (payload.nonce !== expected.nonce) {
    throw invalid("the nonce does not match");
  }
  if (typeof payload.sub !== "string" || payload.sub === "") {
    throw invalid("it has no subject");
  }
  return { subject: payload.sub, email: typeof payload.email === "string" ? payload.email : "" };
}

/**
 * Finishes a sign-in from the callback address: validates the callback, exchanges
 * the code, validates the ID token and checks that ChatGPT plan use was granted.
 */
export async function completeSignIn(
  fetchFn: FetchLike,
  callbackUrl: string,
  pending: PendingSignIn,
  now: number,
): Promise<ChatGptAuth> {
  const { code, clientId } = parseCallback(callbackUrl, pending);
  const response = await postForm(fetchFn, TOKEN_URL, {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: pending.verifier,
    redirect_uri: pending.redirectUri,
    resource: RESOURCE,
  });
  const tokens = response.ok ? readTokenResponse(response.body) : null;
  if (tokens === null || tokens.refreshToken === "" || tokens.idToken === "") {
    const reason = safeMessage(errorMessageFromBody(response.body)) || `HTTP ${response.status}`;
    throw new SignInError("exchange-failed", reason);
  }
  const identity = await verifyIdToken(fetchFn, tokens.idToken, { clientId, nonce: pending.nonce, now });
  if (pending.expectedSubject !== null && identity.subject !== pending.expectedSubject) {
    throw new SignInError("account-mismatch");
  }
  if (!tokens.scopes.includes(PLAN_SCOPE)) {
    throw new SignInError("plan-not-enabled");
  }
  return {
    clientId,
    subject: identity.subject,
    email: identity.email,
    idToken: tokens.idToken,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: now + tokens.expiresIn * 1000,
    earliestRefreshAt: tokens.earliestRefreshAt,
    scopes: tokens.scopes,
  };
}

const UNUSABLE_REFRESH_CODES = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
  "invalid_client",
]);

/** True when the access token should be renewed before it is used. */
export function needsRefresh(auth: ChatGptAuth, now: number): boolean {
  if (now >= auth.expiresAt) {
    return true;
  }
  return now >= auth.expiresAt - REFRESH_MARGIN_MS && now >= auth.earliestRefreshAt;
}

/**
 * Standard OAuth refresh. Returns the replacement credentials: the caller stores
 * them before using them, because refresh tokens rotate. An unusable refresh token
 * needs a new sign-in and is reported as an auth failure.
 */
export async function refreshTokens(fetchFn: FetchLike, auth: ChatGptAuth, now: number): Promise<ChatGptAuth> {
  if (auth.refreshToken === "") {
    throw new AccessPointError("auth", "not signed in");
  }
  const response = await postForm(fetchFn, TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: auth.clientId,
    refresh_token: auth.refreshToken,
    resource: RESOURCE,
  });
  if (!response.ok) {
    const code = errorCodeFromBody(response.body);
    const message = `sign-in could not be renewed: ${safeMessage(errorMessageFromBody(response.body), [auth.refreshToken]) || `HTTP ${response.status}`}`;
    if (UNUSABLE_REFRESH_CODES.has(code) || response.status === 401 || response.status === 403) {
      throw new AccessPointError("auth", message);
    }
    throw new AccessPointError(response.status === 429 ? "quota" : "transient", message);
  }
  const tokens = readTokenResponse(response.body);
  if (tokens === null) {
    throw new AccessPointError("transient", "sign-in could not be renewed: unexpected answer");
  }
  return {
    ...auth,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken !== "" ? tokens.refreshToken : auth.refreshToken,
    idToken: tokens.idToken !== "" ? tokens.idToken : auth.idToken,
    expiresAt: now + tokens.expiresIn * 1000,
    earliestRefreshAt: tokens.earliestRefreshAt,
    scopes: tokens.scopes.length > 0 ? tokens.scopes : auth.scopes,
  };
}

/**
 * Ends the renewable session at the revocation endpoint. Returns true when the
 * revocation was confirmed. An empty HTTP 200 is success, also for a token that
 * was already invalid.
 */
export async function revokeSession(fetchFn: FetchLike, auth: ChatGptAuth): Promise<boolean> {
  if (auth.refreshToken === "") {
    return true;
  }
  try {
    const discovery = await request(fetchFn, DISCOVERY_URL, { method: "GET", headers: { accept: "application/json" } });
    const endpoint =
      discovery.ok && typeof discovery.body === "object" && discovery.body !== null
        ? (discovery.body as { revocation_endpoint?: unknown }).revocation_endpoint
        : null;
    if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
      return false;
    }
    const response = await postForm(fetchFn, endpoint, {
      token: auth.refreshToken,
      token_type_hint: "refresh_token",
      client_id: auth.clientId,
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

/** Credentials after signing out: tokens cleared, the account and client mapping kept. */
export function signedOut(auth: ChatGptAuth): ChatGptAuth {
  return { ...auth, idToken: "", accessToken: "", refreshToken: "", expiresAt: 0, earliestRefreshAt: 0, scopes: [] };
}
