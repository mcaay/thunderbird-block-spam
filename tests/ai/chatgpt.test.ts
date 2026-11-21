import { describe, expect, it } from "vitest";
import { CHATGPT_MODELS_URL, CHATGPT_RESPONSES_URL, listChatGptModels, readEventStream, scoreChatGpt } from "../../src/ai/chatgpt";
import { TOKEN_URL } from "../../src/ai/chatgptAuth";
import { AccessPointError } from "../../src/core/chain";
import { OUTPUT_LINE } from "../../src/core/score";
import type { AccessPoint, ChatGptAuth } from "../../src/core/types";
import { accessPoint } from "../helpers/harness";
import { fakeFetch, jsonResponse, sseResponse } from "../helpers/http";
import type { Handler } from "../helpers/http";

const NOW = Date.UTC(2026, 10, 21, 12);
const PROMPT = "Is this email spam for its recipient?";
const PAYLOAD = "From: a@b.example\n\nBody";

function auth(partial: Partial<ChatGptAuth> = {}): ChatGptAuth {
  return {
    clientId: "oaiapp_abc",
    subject: "user-123",
    email: "user@example.com",
    idToken: "id-1",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: NOW + 3600 * 1000,
    earliestRefreshAt: 0,
    scopes: ["chatgpt.tokens.use.direct"],
    ...partial,
  };
}

function point(partial: Partial<AccessPoint> = {}): AccessPoint {
  return accessPoint({ id: "gpt", type: "chatgpt", endpoint: CHATGPT_RESPONSES_URL, model: "gpt-6.2-sol", apiKey: "", auth: auth(), ...partial });
}

function setup(handlers: Record<string, Handler>) {
  const http = fakeFetch(handlers);
  const persisted: (ChatGptAuth | null)[] = [];
  const target = { current: null as AccessPoint | null };
  const deps = {
    fetch: http.fetch,
    now: () => NOW,
    persist: async () => {
      persisted.push(target.current?.auth ? { ...target.current.auth } : null);
    },
  };
  return { http, deps, persisted, target };
}

function completed(text: string): Handler {
  return () =>
    sseResponse([
      { type: "response.created", response: { id: "resp_1" } },
      ...[...text].map((delta) => ({ type: "response.output_text.delta", delta })),
      { type: "response.completed", response: { id: "resp_1", status: "completed" } },
    ]);
}

async function failure(run: Promise<unknown>): Promise<AccessPointError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof AccessPointError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a failure");
}

describe("ChatGPT plan adapter", () => {
  it("calls the Responses API with store false and stream true and reads until response.completed", async () => {
    const { http, deps } = setup({ [CHATGPT_RESPONSES_URL]: completed("0.91") });
    expect(await scoreChatGpt(point(), PROMPT, PAYLOAD, deps)).toBe(0.91);
    const sent = http.requests[0];
    expect(sent?.url).toBe("https://api.openai.com/v1/responses");
    expect(sent?.method).toBe("POST");
    expect(sent?.headers.authorization).toBe("Bearer access-1");
    expect(sent?.json).toEqual({
      model: "gpt-6.2-sol",
      instructions: `${PROMPT}\n\n${OUTPUT_LINE}`,
      input: [{ role: "user", content: PAYLOAD }],
      store: false,
      stream: true,
    });
  });

  it("omits the fields the preview does not support", async () => {
    const { http, deps } = setup({ [CHATGPT_RESPONSES_URL]: completed("0") });
    await scoreChatGpt(point(), PROMPT, PAYLOAD, deps);
    for (const field of ["max_output_tokens", "temperature", "top_p", "metadata", "user", "truncation", "previous_response_id"]) {
      expect(http.requests[0]?.json).not.toHaveProperty(field);
    }
  });

  it("fails when the stream ends without response.completed", async () => {
    const { deps } = setup({
      [CHATGPT_RESPONSES_URL]: () => sseResponse([{ type: "response.output_text.delta", delta: "0.9" }]),
    });
    expect(await failure(scoreChatGpt(point(), PROMPT, PAYLOAD, deps))).toMatchObject({ kind: "transient", message: "the answer ended early" });
  });

  it("treats the usage limit error as a quota error, also inside the stream", async () => {
    const inStream = setup({
      [CHATGPT_RESPONSES_URL]: () =>
        sseResponse([
          { type: "response.output_text.delta", delta: "0." },
          { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "Usage limit reached" } } },
        ]),
    });
    expect((await failure(scoreChatGpt(point(), PROMPT, PAYLOAD, inStream.deps))).kind).toBe("quota");

    const beforeStream = setup({
      [CHATGPT_RESPONSES_URL]: () =>
        jsonResponse({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "Usage limit reached" } }, 429, { "retry-after": "60" }),
    });
    expect(await failure(scoreChatGpt(point(), PROMPT, PAYLOAD, beforeStream.deps))).toMatchObject({ kind: "quota", retryAfterMs: 60_000 });
  });

  it("classifies the other documented errors", async () => {
    const cases: [number, unknown, string][] = [
      [503, { error: { code: "subscription_sharing_usage_unavailable", message: "try later" } }, "transient"],
      [503, { error: { code: "subscription_sharing_user_unavailable", message: "try later" } }, "transient"],
      [403, { error: { code: "subscription_sharing_user_not_eligible", message: "not eligible" } }, "auth"],
      [401, { error: { code: "subscription_sharing_invalid_user", message: "invalid" } }, "auth"],
      [403, { error: { code: "chatpass_v2_scope_not_authorized", message: "no" } }, "auth"],
      [400, { error: { code: "subscription_sharing_unsupported_capability", message: "bad", param: "model" } }, "transient"],
      [401, { detail: "identity not accepted" }, "auth"],
      [403, { detail: "region not permitted" }, "auth"],
      [503, { detail: "direct routing unavailable" }, "transient"],
      [429, { detail: "slow down" }, "quota"],
    ];
    for (const [status, body, kind] of cases) {
      const { deps } = setup({ [CHATGPT_RESPONSES_URL]: () => jsonResponse(body, status) });
      expect((await failure(scoreChatGpt(point(), PROMPT, PAYLOAD, deps))).kind, JSON.stringify(body)).toBe(kind);
    }
  });

  it("fails on incomplete responses and on output that is not just a number", async () => {
    const incomplete = setup({ [CHATGPT_RESPONSES_URL]: () => sseResponse([{ type: "response.incomplete", response: {} }]) });
    expect((await failure(scoreChatGpt(point(), PROMPT, PAYLOAD, incomplete.deps))).message).toBe("the answer is incomplete");
    const chatty = setup({ [CHATGPT_RESPONSES_URL]: completed("I think 0.9") });
    expect((await failure(scoreChatGpt(point(), PROMPT, PAYLOAD, chatty.deps))).kind).toBe("transient");
    const refusal = setup({
      [CHATGPT_RESPONSES_URL]: () =>
        sseResponse([{ type: "response.refusal.delta", delta: "No." }, { type: "response.completed", response: {} }]),
    });
    expect((await failure(scoreChatGpt(point(), PROMPT, PAYLOAD, refusal.deps))).kind).toBe("transient");
  });

  it("needs a sign-in and a model", async () => {
    const { http, deps } = setup({});
    expect(await failure(scoreChatGpt(point({ auth: null }), PROMPT, PAYLOAD, deps))).toMatchObject({ kind: "auth", message: "not signed in" });
    expect(await failure(scoreChatGpt(point({ auth: auth({ refreshToken: "", accessToken: "" }) }), PROMPT, PAYLOAD, deps))).toMatchObject({ kind: "auth" });
    expect((await failure(scoreChatGpt(point({ model: "" }), PROMPT, PAYLOAD, deps))).message).toBe("no model is selected");
    expect(http.requests).toHaveLength(0);
  });

  it("refreshes an expiring token and stores the replacement before using it", async () => {
    const { http, deps, persisted, target } = setup({
      [TOKEN_URL]: () => jsonResponse({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }),
      [CHATGPT_RESPONSES_URL]: completed("0.5"),
    });
    const expiring = point({ auth: auth({ expiresAt: NOW + 60 * 1000 }) });
    target.current = expiring;
    const order: string[] = [];
    const persist = deps.persist;
    deps.persist = async () => {
      order.push("persist");
      await persist();
    };
    const fetch = deps.fetch;
    deps.fetch = async (url, init) => {
      order.push(url);
      return fetch(url, init);
    };
    expect(await scoreChatGpt(expiring, PROMPT, PAYLOAD, deps)).toBe(0.5);
    expect(order).toEqual([TOKEN_URL, "persist", CHATGPT_RESPONSES_URL]);
    expect(persisted[0]).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
    expect(http.requests[1]?.headers.authorization).toBe("Bearer access-2");
    expect(expiring.auth).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2", expiresAt: NOW + 3600 * 1000 });
  });

  it("serializes refreshes so a rotating refresh token is used once", async () => {
    const { http, deps, target } = setup({
      [TOKEN_URL]: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return jsonResponse({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 });
      },
      [CHATGPT_RESPONSES_URL]: completed("0.5"),
    });
    const expiring = point({ auth: auth({ expiresAt: NOW - 1 }) });
    target.current = expiring;
    await Promise.all([scoreChatGpt(expiring, PROMPT, PAYLOAD, deps), scoreChatGpt(expiring, PROMPT, PAYLOAD, deps)]);
    expect(http.requests.filter((request) => request.url === TOKEN_URL)).toHaveLength(1);
    expect(http.requests.filter((request) => request.url === CHATGPT_RESPONSES_URL)).toHaveLength(2);
  });

  it("clears unusable tokens and asks for a new sign-in", async () => {
    const { http, deps, persisted, target } = setup({
      [TOKEN_URL]: () => jsonResponse({ error: "refresh_token_reused" }, 400),
    });
    const expired = point({ auth: auth({ expiresAt: NOW - 1 }) });
    target.current = expired;
    expect((await failure(scoreChatGpt(expired, PROMPT, PAYLOAD, deps))).kind).toBe("auth");
    expect(expired.auth).toMatchObject({ accessToken: "", refreshToken: "", clientId: "oaiapp_abc", idToken: "id-1" });
    expect(persisted).toHaveLength(1);
    expect(http.requests.some((request) => request.url === CHATGPT_RESPONSES_URL)).toBe(false);
  });

  it("keeps the tokens when the refresh fails for a temporary reason", async () => {
    const { deps, target } = setup({ [TOKEN_URL]: () => jsonResponse({ error: "server_error" }, 503) });
    const expired = point({ auth: auth({ expiresAt: NOW - 1 }) });
    target.current = expired;
    expect((await failure(scoreChatGpt(expired, PROMPT, PAYLOAD, deps))).kind).toBe("transient");
    expect(expired.auth?.refreshToken).toBe("refresh-1");
  });

  it("lists the models meant for display, in the server's order", async () => {
    const { http, deps } = setup({
      [CHATGPT_MODELS_URL]: () =>
        jsonResponse({
          models: [
            { slug: "gpt-6.2-sol", display_name: "GPT-6.2 Sol", visibility: "list" },
            { slug: "internal-model", display_name: "Internal", visibility: "hide" },
            { slug: "gpt-6-luna", visibility: "list" },
          ],
        }),
    });
    expect(await listChatGptModels(point(), deps)).toEqual([
      { id: "gpt-6.2-sol", label: "GPT-6.2 Sol" },
      { id: "gpt-6-luna", label: "gpt-6-luna" },
    ]);
    expect(http.requests[0]).toMatchObject({ url: "https://api.openai.com/v1/models", method: "GET" });
    expect(http.requests[0]?.headers.authorization).toBe("Bearer access-1");
  });
});

describe("event stream parser", () => {
  function stream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
  }

  it("handles events split across chunks and both line endings", async () => {
    const events: unknown[] = [];
    await readEventStream(
      stream(['event: a\ndata: {"type":"one",', '"n":1}\n\nevent: b\r\ndata: {"type":"two"}\r\n\r\n', "data: [DONE]\n\n", 'data: {"type":"three"}']),
      (event) => {
        events.push(event);
        return false;
      },
    );
    expect(events).toEqual([{ type: "one", n: 1 }, { type: "two" }, { type: "three" }]);
  });

  it("stops when the handler says so and ignores lines that are not JSON", async () => {
    const events: unknown[] = [];
    await readEventStream(stream([': comment\n\ndata: not json\n\ndata: {"type":"one"}\n\ndata: {"type":"two"}\n\n']), (event) => {
      events.push(event);
      return true;
    });
    expect(events).toEqual([{ type: "one" }]);
  });
});
