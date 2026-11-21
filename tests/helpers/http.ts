// A fake HTTP layer for adapter tests.

import type { FetchLike } from "../../src/ai/http";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  json: unknown;
  form: Record<string, string>;
  redirect: RequestRedirect | undefined;
}

export type Handler = (request: RecordedRequest) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function sseResponse(events: unknown[], status = 200): Response {
  const text = events
    .map((event) => `event: ${(event as { type?: string }).type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(text, { status, headers: { "content-type": "text/event-stream" } });
}

/** A fetch that records every request and answers with the handler registered for the URL. */
export function fakeFetch(handlers: Record<string, Handler> | Handler): { fetch: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }
    const body = typeof init.body === "string" ? init.body : "";
    let json: unknown = null;
    try {
      json = JSON.parse(body) as unknown;
    } catch {
      json = null;
    }
    const recorded: RecordedRequest = {
      url,
      method: init.method ?? "GET",
      headers,
      body,
      json,
      form: Object.fromEntries(new URLSearchParams(body)),
      redirect: init.redirect,
    };
    requests.push(recorded);
    const handler = typeof handlers === "function" ? handlers : handlers[url];
    if (handler === undefined) {
      throw new TypeError(`unexpected request to ${url}`);
    }
    return handler(recorded);
  };
  return { fetch, requests };
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Creates signed ID tokens and the matching JWKS, for tests of ID token validation. */
export async function tokenFactory(algorithm: "RS256" | "ES256" = "RS256"): Promise<{
  jwks: { keys: unknown[] };
  sign(claims: Record<string, unknown>, kid?: string): Promise<string>;
}> {
  const params =
    algorithm === "RS256"
      ? { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }
      : { name: "ECDSA", namedCurve: "P-256" };
  const pair = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const kid = "test-key";
  return {
    jwks: { keys: [{ ...jwk, kid, alg: algorithm, use: "sig" }] },
    async sign(claims, keyId = kid) {
      const encoder = new TextEncoder();
      const head = base64Url(encoder.encode(JSON.stringify({ alg: algorithm, typ: "JWT", kid: keyId })));
      const payload = base64Url(encoder.encode(JSON.stringify(claims)));
      const signature = await crypto.subtle.sign(
        algorithm === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        encoder.encode(`${head}.${payload}`),
      );
      return `${head}.${payload}.${base64Url(new Uint8Array(signature))}`;
    },
  };
}
