import { beforeAll, describe, expect, it } from "vitest";
import {
  AUTHORIZE_URL,
  beginSignIn,
  completeSignIn,
  DISCOVERY_URL,
  ISSUER,
  JWKS_URL,
  needsRefresh,
  parseCallback,
  pkceChallenge,
  REDIRECT_URI,
  refreshTokens,
  revokeSession,
  SignInError,
  signedOut,
  TOKEN_URL,
  verifyIdToken,
} from "../../src/ai/chatgptAuth";
import type { PendingSignIn } from "../../src/ai/chatgptAuth";
import { AccessPointError } from "../../src/core/chain";
import type { ChatGptAuth } from "../../src/core/types";
import { fakeFetch, jsonResponse, tokenFactory } from "../helpers/http";

const NOW = Date.UTC(2026, 10, 21, 12);
const HOST_ID = "urn:uuid:0b1f3c7e-1a2b-4c3d-8e9f-001122334455";
const ALL_SCOPES = "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke";

let factory: Awaited<ReturnType<typeof tokenFactory>>;

beforeAll(async () => {
  factory = await tokenFactory("RS256");
});

function claims(pending: PendingSignIn, clientId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: clientId,
    sub: "user-123",
    email: "user@example.com",
    nonce: pending.nonce,
    iat: Math.floor(NOW / 1000),
    exp: Math.floor(NOW / 1000) + 3600,
    ...extra,
  };
}

async function expectSignInError(run: Promise<unknown>, code: string): Promise<void> {
  await expect(run).rejects.toSatisfy((error) => error instanceof SignInError && error.code === code);
}

function callback(pending: PendingSignIn, params: Record<string, string>): string {
  return `${REDIRECT_URI}?${new URLSearchParams({ state: pending.state, ...params }).toString()}`;
}

describe("beginSignIn", () => {
  it("registers a new client through dynamic_agent_client", async () => {
    const { url, pending } = await beginSignIn({ hostId: HOST_ID, returning: null, accessPointId: null, now: NOW });
    const parsed = new URL(url);
    const params = parsed.searchParams;
    expect(`${parsed.origin}${parsed.pathname}`).toBe(AUTHORIZE_URL);
    expect(params.get("client_id")).toBe("dynamic_agent_client");
    expect(params.get("agent_name_hint")).toBe("Block Spam");
    expect(params.get("ext_agent_host_id")).toBe(HOST_ID);
    expect(params.get("response_type")).toBe("code");
    expect(params.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
    expect(params.get("scope")).toBe("openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
    expect(params.get("resource")).toBe("https://api.openai.com/v1");
    expect(params.get("state")).toBe(pending.state);
    expect(params.get("nonce")).toBe(pending.nonce);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBe(await pkceChallenge(pending.verifier));
    expect(params.has("id_token_hint")).toBe(false);
    expect(pending).toMatchObject({ clientId: null, expectedSubject: null, accessPointId: null, startedAt: NOW });
  });

  it("uses fresh random values for every attempt", async () => {
    const first = await beginSignIn({ hostId: HOST_ID, returning: null, accessPointId: null, now: NOW });
    const second = await beginSignIn({ hostId: HOST_ID, returning: null, accessPointId: null, now: NOW });
    expect(first.pending.state).not.toBe(second.pending.state);
    expect(first.pending.nonce).not.toBe(second.pending.nonce);
    expect(first.pending.verifier).not.toBe(second.pending.verifier);
    expect(first.pending.verifier.length).toBeGreaterThanOrEqual(43);
  });

  it("computes the S256 challenge of RFC 7636", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("reuses the issued client id for a returning account and sends hints", async () => {
    const { url, pending } = await beginSignIn({
      hostId: HOST_ID,
      returning: { clientId: "oaiapp_abc", subject: "user-123", email: "user@example.com", idToken: "old.id.token" },
      accessPointId: "ap1",
      now: NOW,
    });
    const params = new URL(url).searchParams;
    expect(params.get("client_id")).toBe("oaiapp_abc");
    expect(params.has("agent_name_hint")).toBe(false);
    expect(params.get("id_token_hint")).toBe("old.id.token");
    expect(params.get("login_hint")).toBe("user@example.com");
    expect(params.get("ext_agent_host_id")).toBe(HOST_ID);
    expect(pending).toMatchObject({ clientId: "oaiapp_abc", expectedSubject: "user-123", accessPointId: "ap1" });
  });

  it("omits the ID token hint after signing out", async () => {
    const { url } = await beginSignIn({
      hostId: HOST_ID,
      returning: { clientId: "oaiapp_abc", subject: "user-123", email: "", idToken: "" },
      accessPointId: "ap1",
      now: NOW,
    });
    const params = new URL(url).searchParams;
    expect(params.has("id_token_hint")).toBe(false);
    expect(params.has("login_hint")).toBe(false);
  });
});

describe("parseCallback", () => {
  it("returns the code and the issued client id of a new registration", async () => {
    const { pending } = await beginSignIn({ hostId: HOST_ID, returning: null, accessPointId: null, now: NOW });
    expect(parseCallback(callback(pending, { code: "abc", client_id: "oaiapp_new", scope: ALL_SCOPES }), pending)).toEqual({
      code: "abc",
      clientId: "oaiapp_new",
    });
  });

  it("rejects an address that is not the callback", async () => {
    const { pending } = await beginSignIn({ hostId: HOST_ID, returning: null, accessPointId: null, now: NOW });
    for (const url of ["not a url", "https://example.com/auth/callback?code=x", "http://127.0.0.1:1455/callback?code=x", "http://localhost:1455/auth/callback?code=x"]) {
      expect(() => parseCallback(url, pending), url).toThrowError(SignInError);
    }
  });

  it("validates the state before anything else", async () => {
    const { pending } = await beginSignIn({ hostId: HOST_ID, returning: null, accessPointId: null, now: NOW });
    const url = `${REDIRECT_URI}?state=other&code=abc&client_id=oaiapp_new`;
    expect(() => parseCallback(url, pending)).toThrowError(/state-mismatch/);
    const denied = `${REDIRECT_URI}?state=other&error=access_denied`;
    expect(() => parseCallback(denied, pending)).toThrowError(/state-mismatch/);
  });

  it("stops on access_denied and on other errors", async () => {
    const { pending } = await beginSignIn({ hostId: HOST_ID, returning: null, accessPointId: null, now: NOW });
    try {
      parseCallback(callback(pending, { error: "access_denied" }), pending);
      expect.unreachable();
    } catch (error) {
      expect((error as SignInError).code).toBe("denied");
    }
    try {
      parseCallback(callback(pending, { error: "server_error", error_description: "try later" }), pending);
      expect.unreachable();
    } catch (error) {
      expect((error as SignInError).code).toBe("provider-error");
    }
  });

  it("treats a new registration without an issued client id as incomplete", async () => {
    const { pending } = await beginSignIn({ hostId: HOST_ID, returning: null, accessPointId: null, now: NOW });
    for (const params of [{ code: "abc" }, { code: "abc", client_id: "dynamic_agent_client" }] as Record<string, string>[]) {
      try {
        parseCallback(callback(pending, params), pending);
        expect.unreachable();
      } catch (error) {
        expect((error as SignInError).code).toBe("registration-incomplete");
      }
    }
  });

  it("requires a code", async () => {
    const { pending } = await beginSignIn({ hostId: HOST_ID, returning: null, accessPointId: null, now: NOW });
    expect(() => parseCallback(callback(pending, { client_id: "oaiapp_new" }), pending)).toThrowError(/no-code/);
  });

  it("keeps the saved client id on reauthorization and rejects a different one", async () => {
    const returning = { clientId: "oaiapp_abc", subject: "user-123", email: "", idToken: "" };
    const { pending } = await beginSignIn({ hostId: HOST_ID, returning, accessPointId: "ap1", now: NOW });
    expect(parseCallback(callback(pending, { code: "abc" }), pending)).toEqual({ code: "abc", clientId: "oaiapp_abc" });
    expect(parseCallback(callback(pending, { code: "abc", client_id: "oaiapp_abc" }), pending).clientId).toBe("oaiapp_abc");
    expect(() => parseCallback(callback(pending, { code: "abc", client_id: "oaiapp_other" }), pending)).toThrowError(/client-mismatch/);
  });
});

describe("verifyIdToken", () => {
  const expected = { clientId: "oaiapp_new", nonce: "nonce-1", now: NOW };
  const base = { iss: ISSUER, aud: "oaiapp_new", sub: "user-123", email: "user@example.com", nonce: "nonce-1", exp: Math.floor(NOW / 1000) + 600 };

  it("accepts a valid RS256 token", async () => {
    const { fetch } = fakeFetch({ [JWKS_URL]: () => jsonResponse(factory.jwks) });
    expect(await verifyIdToken(fetch, await factory.sign(base), expected)).toEqual({
      subject: "user-123",
      email: "user@example.com",
    });
  });

  it("accepts a valid ES256 token and an audience list", async () => {
    const es = await tokenFactory("ES256");
    const { fetch } = fakeFetch({ [JWKS_URL]: () => jsonResponse(es.jwks) });
    const token = await es.sign({ ...base, aud: ["other", "oaiapp_new"] });
    expect((await verifyIdToken(fetch, token, expected)).subject).toBe("user-123");
  });

  it("rejects a token signed with another key", async () => {
    const other = await tokenFactory("RS256");
    const { fetch } = fakeFetch({ [JWKS_URL]: () => jsonResponse(factory.jwks) });
    await expectSignInError(verifyIdToken(fetch, await other.sign(base), expected), "invalid-token");
  });

  it("rejects a tampered payload", async () => {
    const { fetch } = fakeFetch({ [JWKS_URL]: () => jsonResponse(factory.jwks) });
    const [head, , signature] = (await factory.sign(base)).split(".");
    const forged = Buffer.from(JSON.stringify({ ...base, sub: "attacker" })).toString("base64url");
    await expectSignInError(verifyIdToken(fetch, `${head}.${forged}.${signature}`, expected), "invalid-token");
  });

  it("rejects a wrong issuer, audience, nonce, expiry and a missing subject", async () => {
    const { fetch } = fakeFetch({ [JWKS_URL]: () => jsonResponse(factory.jwks) });
    const wrong: Record<string, unknown>[] = [
      { ...base, iss: "https://evil.example" },
      { ...base, aud: "oaiapp_other" },
      { ...base, nonce: "nonce-2" },
      { ...base, exp: Math.floor(NOW / 1000) - 60 },
      { ...base, sub: "" },
    ];
    for (const payload of wrong) {
      await expectSignInError(verifyIdToken(fetch, await factory.sign(payload), expected), "invalid-token");
    }
  });

  it("rejects unsupported algorithms, bad formats and unavailable keys", async () => {
    const { fetch } = fakeFetch({ [JWKS_URL]: () => jsonResponse(factory.jwks) });
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(base)).toString("base64url")}.`;
    await expectSignInError(verifyIdToken(fetch, none, expected), "invalid-token");
    await expectSignInError(verifyIdToken(fetch, "abc", expected), "invalid-token");
    const down = fakeFetch({ [JWKS_URL]: () => jsonResponse({ error: "down" }, 500) });
    await expectSignInError(verifyIdToken(down.fetch, await factory.sign(base), expected), "invalid-token");
  });
});

describe("completeSignIn", () => {
  async function scenario(options: { scope?: string; subject?: string; returning?: boolean } = {}) {
    const returning = options.returning
      ? { clientId: "oaiapp_abc", subject: "user-123", email: "user@example.com", idToken: "old" }
      : null;
    const { pending } = await beginSignIn({ hostId: HOST_ID, returning, accessPointId: null, now: NOW });
    const clientId = returning?.clientId ?? "oaiapp_new";
    const idToken = await factory.sign(claims(pending, clientId, { sub: options.subject ?? "user-123" }));
    const http = fakeFetch({
      [TOKEN_URL]: () =>
        jsonResponse({
          access_token: "access-1",
          refresh_token: "refresh-1",
          id_token: idToken,
          token_type: "Bearer",
          expires_in: 3600,
          scope: options.scope ?? ALL_SCOPES,
          earliest_refresh_at: Math.floor(NOW / 1000) + 1800,
        }),
      [JWKS_URL]: () => jsonResponse(factory.jwks),
    });
    const url = callback(pending, returning ? { code: "the-code" } : { code: "the-code", client_id: "oaiapp_new" });
    return { pending, http, url, idToken };
  }

  it("exchanges the code and returns validated credentials", async () => {
    const { pending, http, url, idToken } = await scenario();
    const auth = await completeSignIn(http.fetch, url, pending, NOW);
    expect(auth).toEqual({
      clientId: "oaiapp_new",
      subject: "user-123",
      email: "user@example.com",
      idToken,
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: NOW + 3600 * 1000,
      earliestRefreshAt: NOW + 1800 * 1000,
      scopes: ALL_SCOPES.split(" "),
    });
    const exchange = http.requests[0];
    expect(exchange?.url).toBe(TOKEN_URL);
    expect(exchange?.method).toBe("POST");
    expect(exchange?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(exchange?.form).toEqual({
      grant_type: "authorization_code",
      client_id: "oaiapp_new",
      code: "the-code",
      code_verifier: pending.verifier,
      redirect_uri: REDIRECT_URI,
      resource: "https://api.openai.com/v1",
    });
  });

  it("fails when ChatGPT plan use was not granted", async () => {
    const { pending, http, url } = await scenario({ scope: "email openid profile offline_access" });
    await expectSignInError(completeSignIn(http.fetch, url, pending, NOW), "plan-not-enabled");
  });

  it("fails when a different account signs in on reauthorization", async () => {
    const { pending, http, url } = await scenario({ returning: true, subject: "someone-else" });
    await expectSignInError(completeSignIn(http.fetch, url, pending, NOW), "account-mismatch");
  });

  it("accepts the same account on reauthorization", async () => {
    const { pending, http, url } = await scenario({ returning: true });
    expect((await completeSignIn(http.fetch, url, pending, NOW)).clientId).toBe("oaiapp_abc");
    expect(http.requests[0]?.form.client_id).toBe("oaiapp_abc");
  });

  it("reports a failed exchange", async () => {
    const { pending, url } = await scenario();
    const http = fakeFetch({
      [TOKEN_URL]: () => jsonResponse({ error: "invalid_grant", error_description: "code expired" }, 400),
    });
    await expect(completeSignIn(http.fetch, url, pending, NOW)).rejects.toSatisfy(
      (error) => error instanceof SignInError && error.code === "exchange-failed" && error.detail === "invalid_grant: code expired",
    );
  });

  it("makes no request when the callback is invalid", async () => {
    const { pending, http } = await scenario();
    await expectSignInError(completeSignIn(http.fetch, `${REDIRECT_URI}?state=wrong&code=x`, pending, NOW), "state-mismatch");
    expect(http.requests).toHaveLength(0);
  });
});

const AUTH: ChatGptAuth = {
  clientId: "oaiapp_abc",
  subject: "user-123",
  email: "user@example.com",
  idToken: "id-1",
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: NOW + 3600 * 1000,
  earliestRefreshAt: 0,
  scopes: ALL_SCOPES.split(" "),
};

describe("refreshing tokens", () => {
  it("knows when a refresh is due", () => {
    expect(needsRefresh(AUTH, NOW)).toBe(false);
    expect(needsRefresh(AUTH, AUTH.expiresAt - 4 * 60 * 1000)).toBe(true);
    expect(needsRefresh(AUTH, AUTH.expiresAt + 1)).toBe(true);
    const early = { ...AUTH, earliestRefreshAt: AUTH.expiresAt - 60 * 1000 };
    expect(needsRefresh(early, AUTH.expiresAt - 4 * 60 * 1000)).toBe(false);
    expect(needsRefresh(early, AUTH.expiresAt - 30 * 1000)).toBe(true);
  });

  it("returns the replacement tokens", async () => {
    const http = fakeFetch({
      [TOKEN_URL]: () => jsonResponse({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }),
    });
    const fresh = await refreshTokens(http.fetch, AUTH, NOW + 1000);
    expect(fresh).toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      idToken: "id-1",
      clientId: "oaiapp_abc",
      expiresAt: NOW + 1000 + 3600 * 1000,
      scopes: AUTH.scopes,
    });
    expect(http.requests[0]?.form).toEqual({
      grant_type: "refresh_token",
      client_id: "oaiapp_abc",
      refresh_token: "refresh-1",
      resource: "https://api.openai.com/v1",
    });
  });

  it("asks for a new sign-in when the refresh token is unusable", async () => {
    for (const code of ["invalid_grant", "refresh_token_reused", "refresh_token_expired", "invalid_client"]) {
      const http = fakeFetch({ [TOKEN_URL]: () => jsonResponse({ error: code }, 400) });
      await expect(refreshTokens(http.fetch, AUTH, NOW)).rejects.toSatisfy(
        (error) => error instanceof AccessPointError && error.kind === "auth",
      );
    }
  });

  it("treats server trouble as temporary", async () => {
    const http = fakeFetch({ [TOKEN_URL]: () => jsonResponse({ error: "server_error" }, 503) });
    await expect(refreshTokens(http.fetch, AUTH, NOW)).rejects.toSatisfy(
      (error) => error instanceof AccessPointError && error.kind === "transient",
    );
  });

  it("never puts the refresh token into an error message", async () => {
    const http = fakeFetch({
      [TOKEN_URL]: () => jsonResponse({ error: "invalid_grant", error_description: "token refresh-1 is unknown" }, 400),
    });
    await expect(refreshTokens(http.fetch, AUTH, NOW)).rejects.toSatisfy(
      (error) => error instanceof Error && !error.message.includes("refresh-1"),
    );
  });

  it("refuses to refresh without a refresh token", async () => {
    const http = fakeFetch({});
    await expect(refreshTokens(http.fetch, signedOut(AUTH), NOW)).rejects.toSatisfy(
      (error) => error instanceof AccessPointError && error.kind === "auth",
    );
    expect(http.requests).toHaveLength(0);
  });
});

describe("signing out", () => {
  it("revokes the refresh token at the revocation endpoint", async () => {
    const http = fakeFetch({
      [DISCOVERY_URL]: () => jsonResponse({ revocation_endpoint: "https://auth.openai.com/oauth/revoke" }),
      "https://auth.openai.com/oauth/revoke": () => new Response("", { status: 200 }),
    });
    expect(await revokeSession(http.fetch, AUTH)).toBe(true);
    expect(http.requests[1]?.form).toEqual({
      token: "refresh-1",
      token_type_hint: "refresh_token",
      client_id: "oaiapp_abc",
    });
  });

  it("reports an unconfirmed revocation", async () => {
    const failing = fakeFetch({
      [DISCOVERY_URL]: () => jsonResponse({ revocation_endpoint: "https://auth.openai.com/oauth/revoke" }),
      "https://auth.openai.com/oauth/revoke": () => new Response("", { status: 503 }),
    });
    expect(await revokeSession(failing.fetch, AUTH)).toBe(false);
    const offline = fakeFetch({});
    expect(await revokeSession(offline.fetch, AUTH)).toBe(false);
  });

  it("clears tokens and keeps the account and client mapping", () => {
    expect(signedOut(AUTH)).toEqual({
      clientId: "oaiapp_abc",
      subject: "user-123",
      email: "user@example.com",
      idToken: "",
      accessToken: "",
      refreshToken: "",
      expiresAt: 0,
      earliestRefreshAt: 0,
      scopes: [],
    });
  });
});
