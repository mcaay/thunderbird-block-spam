import { describe, expect, it } from "vitest";
import { createAi, requiredOrigins } from "../../src/ai";
import { ANTHROPIC_MESSAGES_URL, scoreAnthropic } from "../../src/ai/anthropic";
import { CHATGPT_RESPONSES_URL } from "../../src/ai/chatgpt";
import {
  errorCodeFromBody,
  errorMessageFromBody,
  isLoopbackHost,
  originPattern,
  parseRetryAfter,
  postForm,
  request,
  safeMessage,
  statusError,
  validateEndpoint,
} from "../../src/ai/http";
import { listOpenAiChatModels, scoreOpenAiChat } from "../../src/ai/openaiChat";
import { OPENAI_DECISIONS_URL, scoreOpenAiDecisions } from "../../src/ai/openaiDecisions";
import { checkDefinition, FIXED_ENDPOINTS, newAccessPoint, normalizeDefinition, PRESETS } from "../../src/ai/presets";
import { readSystemOneAnswer, scoreSystemOne } from "../../src/ai/systemOne";
import { AccessPointError } from "../../src/core/chain";
import { OUTPUT_LINE } from "../../src/core/score";
import type { AccessPoint } from "../../src/core/types";
import { accessPoint } from "../helpers/harness";
import { fakeFetch, jsonResponse } from "../helpers/http";
import type { Handler } from "../helpers/http";

const NOW = 5_000_000;
const PROMPT = "Is this email spam for its recipient?";
const PAYLOAD = "From: a@b.example\nTo: me@c.example\nSubject: Hi\nDate: \n\nBody";

function deps(handler: Handler) {
  const http = fakeFetch(handler);
  return { http, deps: { fetch: http.fetch, now: () => NOW } };
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

describe("HTTP helpers", () => {
  it("classifies status codes as the chain expects", () => {
    expect(statusError(401, {}, null, NOW).kind).toBe("auth");
    expect(statusError(403, {}, null, NOW).kind).toBe("auth");
    expect(statusError(429, {}, null, NOW)).toMatchObject({ kind: "quota", retryAfterMs: null });
    expect(statusError(429, {}, "120", NOW)).toMatchObject({ kind: "quota", retryAfterMs: 120_000 });
    expect(statusError(402, {}, null, NOW).kind).toBe("quota");
    for (const status of [400, 404, 408, 422, 500, 502, 503, 529]) {
      expect(statusError(status, {}, null, NOW).kind, String(status)).toBe("transient");
    }
  });

  it("reads Retry-After as seconds or as a date", () => {
    expect(parseRetryAfter("30", NOW)).toBe(30_000);
    expect(parseRetryAfter("0", NOW)).toBe(1000);
    expect(parseRetryAfter(new Date(NOW + 45_000).toUTCString(), NOW)).toBeGreaterThan(40_000);
    expect(parseRetryAfter(null, NOW)).toBeNull();
    expect(parseRetryAfter("soon", NOW)).toBeNull();
    expect(parseRetryAfter("-5", NOW)).toBeNull();
  });

  it("refuses redirects for every POST, which carries the mail or a token", async () => {
    const { http, deps: context } = deps(() => jsonResponse({ answers: { spam: { type: "noul", noul: 0.4 } } }));
    await scoreSystemOne(accessPoint({ type: "systemone", endpoint: "http://localhost:8000/v1/systemone" }), PROMPT, PAYLOAD, context);
    await postForm(http.fetch, "https://auth.example/token", { grant_type: "refresh_token" });
    await request(http.fetch, "https://api.example.com/v1/models", { method: "GET" });
    expect(http.requests.map((sent) => [sent.method, sent.redirect])).toEqual([
      ["POST", "error"],
      ["POST", "error"],
      ["GET", undefined],
    ]);
  });

  it("caps Retry-After at a day, also when the number of seconds overflows", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(parseRetryAfter("1e306", NOW)).toBe(day);
    expect(parseRetryAfter(String(3 * 24 * 60 * 60), NOW)).toBe(day);
    expect(parseRetryAfter("Fri, 31 Dec 9999 23:59:59 GMT", NOW)).toBe(day);
    expect(parseRetryAfter("Infinity", NOW)).toBeNull();
  });

  it("finds the error message of each provider's error shape", () => {
    expect(errorMessageFromBody({ error: { message: "Incorrect API key", type: "invalid_request_error", code: "invalid_api_key" } })).toBe(
      "invalid_api_key: invalid_request_error: Incorrect API key",
    );
    expect(errorMessageFromBody({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })).toBe(
      "authentication_error: invalid x-api-key",
    );
    expect(errorMessageFromBody({ detail: "max_tokens_exceeded" })).toBe("max_tokens_exceeded");
    expect(errorMessageFromBody({ detail: [{ loc: ["body", "state"], msg: "Field required" }] })).toContain("Field required");
    expect(errorMessageFromBody({ success: false, errors: [{ code: 10000, message: "Authentication error" }] })).toBe("Authentication error");
    expect(errorMessageFromBody({ error: "invalid_grant", error_description: "expired" })).toBe("invalid_grant: expired");
    expect(errorMessageFromBody("plain text")).toBe("plain text");
    expect(errorMessageFromBody(null)).toBe("");
    expect(errorCodeFromBody({ error: { code: "insufficient_quota" } })).toBe("insufficient_quota");
    expect(errorCodeFromBody({ error: "invalid_grant" })).toBe("invalid_grant");
  });

  it("removes secrets from messages and shortens them", () => {
    expect(safeMessage("Incorrect API key provided: sk-secret-123.", ["sk-secret-123"])).toBe("Incorrect API key provided: ***.");
    expect(safeMessage("x".repeat(1000)).length).toBeLessThanOrEqual(303);
    expect(statusError(401, { error: { message: "bad key sk-secret-123" } }, null, NOW, ["sk-secret-123"]).message).toBe("HTTP 401: bad key ***");
  });

  it("allows http only on loopback addresses", () => {
    expect(validateEndpoint("https://api.openai.com/v1")).toMatchObject({ ok: true });
    expect(validateEndpoint("http://localhost:11434/v1")).toMatchObject({ ok: true });
    expect(validateEndpoint("http://127.0.0.1:1234/v1")).toMatchObject({ ok: true });
    expect(validateEndpoint("http://192.168.1.20:11434/v1")).toEqual({ ok: false, reason: "insecure" });
    expect(validateEndpoint("http://api.example.com/v1")).toEqual({ ok: false, reason: "insecure" });
    expect(validateEndpoint("http://localhost.evil.example/v1")).toEqual({ ok: false, reason: "insecure" });
    expect(validateEndpoint("ftp://example.com")).toEqual({ ok: false, reason: "invalid" });
    expect(validateEndpoint("https://user:pass@example.com/v1")).toEqual({ ok: false, reason: "invalid" });
    expect(validateEndpoint("")).toEqual({ ok: false, reason: "invalid" });
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("example.com")).toBe(false);
  });

  it("builds the host permission pattern of an endpoint", () => {
    expect(originPattern(new URL("https://api.openai.com/v1/decisions"))).toBe("https://api.openai.com/*");
    expect(originPattern(new URL("http://localhost:11434/v1"))).toBe("http://localhost/*");
  });

  it("turns network errors and timeouts into temporary failures", async () => {
    const offline = fakeFetch(() => {
      throw new TypeError("NetworkError when attempting to fetch resource.");
    });
    expect(await failure(request(offline.fetch, "https://x.example/", {}))).toMatchObject({ kind: "transient" });

    const hanging = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const timedOut = await failure(request(hanging, "https://x.example/", {}, 20));
    expect(timedOut.kind).toBe("transient");
    expect(timedOut.message).toContain("no answer within");
  });
});

describe("System One adapter", () => {
  const point = accessPoint({ type: "systemone", endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", apiKey: "ts-key" });

  it("sends the payload as state and the prompt as one noul question named spam", async () => {
    const { http, deps: d } = deps(() => jsonResponse({ model: "jev-1.14.0", answers: { spam: { type: "noul", noul: 0.9812 } }, usage: {} }));
    expect(await scoreSystemOne(point, PROMPT, PAYLOAD, d)).toBe(0.98);
    const sent = http.requests[0];
    expect(sent?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(sent?.method).toBe("POST");
    expect(sent?.headers.authorization).toBe("Bearer ts-key");
    expect(sent?.headers["content-type"]).toBe("application/json");
    expect(sent?.json).toEqual({
      model: "jev-latest",
      state: PAYLOAD,
      questions: { spam: { type: "noul", instructions: PROMPT } },
    });
  });

  it("never sends the output line of LLMs", async () => {
    const { http, deps: d } = deps(() => jsonResponse({ answers: { spam: { type: "noul", noul: 0.5 } } }));
    await scoreSystemOne(point, PROMPT, PAYLOAD, d);
    expect(http.requests[0]?.body).not.toContain(OUTPUT_LINE);
  });

  it("reads the answer nested under result, as Cloudflare's REST API wraps it", async () => {
    const wrapped = { result: { model: "clef", answers: { spam: { type: "noul", noul: 0.07 } }, usage: {} }, success: true, errors: [], messages: [] };
    const { deps: d } = deps(() => jsonResponse(wrapped));
    expect(await scoreSystemOne(point, PROMPT, PAYLOAD, d)).toBe(0.07);
    expect(readSystemOneAnswer(wrapped)).toEqual({ type: "noul", noul: 0.07 });
    expect(readSystemOneAnswer({ answers: {} })).toBeNull();
    expect(readSystemOneAnswer("text")).toBeNull();
  });

  it("omits model and key for a local server that needs neither", async () => {
    const local = accessPoint({ type: "systemone", endpoint: "http://localhost:8000/v1/systemone", model: "", apiKey: "" });
    const { http, deps: d } = deps(() => jsonResponse({ answers: { spam: { type: "noul", noul: 1 } } }));
    expect(await scoreSystemOne(local, PROMPT, PAYLOAD, d)).toBe(1);
    expect(http.requests[0]?.headers.authorization).toBeUndefined();
    expect(http.requests[0]?.json).not.toHaveProperty("model");
  });

  it("fails on a refusal, a missing value and a value that is not a probability", async () => {
    const cases: unknown[] = [
      { answers: { spam: { type: "refusal" } } },
      { answers: {} },
      { answers: { other: { type: "noul", noul: 0.5 } } },
      { answers: { spam: { type: "noul" } } },
      { answers: { spam: { type: "noul", noul: "0.5" } } },
      { answers: { spam: { type: "noul", noul: 1.5 } } },
      { success: false, errors: [{ message: "nope" }] },
      "not json",
    ];
    for (const body of cases) {
      const { deps: d } = deps(() => jsonResponse(body));
      expect((await failure(scoreSystemOne(point, PROMPT, PAYLOAD, d))).kind).toBe("transient");
    }
  });

  it("classifies HTTP errors", async () => {
    const unauthorized = deps(() => jsonResponse({ detail: "Invalid API key" }, 401));
    expect(await failure(scoreSystemOne(point, PROMPT, PAYLOAD, unauthorized.deps))).toMatchObject({ kind: "auth", message: "HTTP 401: Invalid API key" });
    const limited = deps(() => jsonResponse({ detail: "slow down" }, 429, { "retry-after": "7" }));
    expect(await failure(scoreSystemOne(point, PROMPT, PAYLOAD, limited.deps))).toMatchObject({ kind: "quota", retryAfterMs: 7000 });
    const overloaded = deps(() => jsonResponse({ detail: "overloaded" }, 529));
    expect((await failure(scoreSystemOne(point, PROMPT, PAYLOAD, overloaded.deps))).kind).toBe("transient");
    const forbiddenOrigin = deps(() => new Response("Forbidden", { status: 403 }));
    expect(await failure(scoreSystemOne(point, PROMPT, PAYLOAD, forbiddenOrigin.deps))).toMatchObject({ kind: "auth", message: "HTTP 403: Forbidden" });
  });
});

describe("OpenAI Decisions adapter", () => {
  const point = accessPoint({ type: "openai-decisions", endpoint: OPENAI_DECISIONS_URL, model: "gpt-6-luna", apiKey: "sk-openai" });

  it("sends the payload as input and one predicate question named spam", async () => {
    const { http, deps: d } = deps(() => jsonResponse({ answers: [{ type: "predicate", name: "spam", probability: 0.92 }] }));
    expect(await scoreOpenAiDecisions(point, PROMPT, PAYLOAD, d)).toBe(0.92);
    expect(http.requests[0]?.url).toBe("https://api.openai.com/v1/decisions");
    expect(http.requests[0]?.headers.authorization).toBe("Bearer sk-openai");
    expect(http.requests[0]?.json).toEqual({
      model: "gpt-6-luna",
      input: PAYLOAD,
      questions: [{ type: "predicate", name: "spam", instructions: PROMPT }],
    });
  });

  it("fails on a refusal, a missing answer and an invalid probability", async () => {
    for (const body of [{ answers: [{ type: "refusal", name: "spam" }] }, { answers: [] }, {}, { answers: [{ type: "predicate", probability: 2 }] }, { answers: [{ type: "predicate" }] }]) {
      const { deps: d } = deps(() => jsonResponse(body));
      expect((await failure(scoreOpenAiDecisions(point, PROMPT, PAYLOAD, d))).kind).toBe("transient");
    }
  });

  it("treats insufficient quota as a quota error and never leaks the key", async () => {
    const { deps: d } = deps(() =>
      jsonResponse({ error: { message: "You exceeded your current quota (key sk-openai)", type: "insufficient_quota", code: "insufficient_quota" } }, 429),
    );
    const error = await failure(scoreOpenAiDecisions(point, PROMPT, PAYLOAD, d));
    expect(error.kind).toBe("quota");
    expect(error.message).not.toContain("sk-openai");
  });
});

describe("OpenAI-compatible chat adapter", () => {
  const point = accessPoint({ type: "openai-chat", endpoint: "https://api.openai.com/v1/", model: "gpt-6-luna", apiKey: "sk-openai" });

  function reply(content: unknown, extra: Record<string, unknown> = {}): Handler {
    return () => jsonResponse({ choices: [{ index: 0, message: { role: "assistant", content, ...extra }, finish_reason: "stop" }] });
  }

  it("sends the prompt plus the output line as system message and the payload as user message", async () => {
    const { http, deps: d } = deps(reply("0.85"));
    expect(await scoreOpenAiChat(point, PROMPT, PAYLOAD, d)).toBe(0.85);
    expect(http.requests[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(http.requests[0]?.headers.authorization).toBe("Bearer sk-openai");
    expect(http.requests[0]?.json).toEqual({
      model: "gpt-6-luna",
      messages: [
        { role: "system", content: `${PROMPT}\n\n${OUTPUT_LINE}` },
        { role: "user", content: PAYLOAD },
      ],
    });
  });

  it("works without a key for local servers", async () => {
    const local = accessPoint({ type: "openai-chat", endpoint: "http://localhost:11434/v1", model: "qwen3:8b", apiKey: "" });
    const { http, deps: d } = deps(reply(" 0.3\n"));
    expect(await scoreOpenAiChat(local, PROMPT, PAYLOAD, d)).toBe(0.3);
    expect(http.requests[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(http.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("accepts content given as text parts", async () => {
    const { deps: d } = deps(reply([{ type: "text", text: "0." }, { type: "text", text: "42" }]));
    expect(await scoreOpenAiChat(point, PROMPT, PAYLOAD, d)).toBe(0.42);
  });

  it("fails on anything that is not just a number", async () => {
    for (const content of ["The probability is 0.9", "0.853", "", "1.2", "<think>hm</think>0.9", null]) {
      const { deps: d } = deps(reply(content));
      expect((await failure(scoreOpenAiChat(point, PROMPT, PAYLOAD, d))).kind).toBe("transient");
    }
  });

  it("fails on refusals and missing choices", async () => {
    const refused = deps(reply(null, { refusal: "I cannot help with that." }));
    expect((await failure(scoreOpenAiChat(point, PROMPT, PAYLOAD, refused.deps))).message).toContain("refused");
    const filtered = deps(() => jsonResponse({ choices: [{ message: { content: "0.9" }, finish_reason: "content_filter" }] }));
    expect((await failure(scoreOpenAiChat(point, PROMPT, PAYLOAD, filtered.deps))).message).toContain("refused");
    const empty = deps(() => jsonResponse({ choices: [] }));
    expect((await failure(scoreOpenAiChat(point, PROMPT, PAYLOAD, empty.deps))).kind).toBe("transient");
  });

  it("needs a model", async () => {
    const { http, deps: d } = deps(reply("0.5"));
    expect((await failure(scoreOpenAiChat({ ...point, model: "" }, PROMPT, PAYLOAD, d))).message).toBe("no model is set");
    expect(http.requests).toHaveLength(0);
  });

  it("lists the models of the endpoint", async () => {
    const { http, deps: d } = deps(() => jsonResponse({ object: "list", data: [{ id: "gpt-6-luna" }, { id: "models/gemini-4-hydrogen" }, {}] }));
    expect(await listOpenAiChatModels(point, d)).toEqual([
      { id: "gpt-6-luna", label: "gpt-6-luna" },
      { id: "gemini-4-hydrogen", label: "gemini-4-hydrogen" },
    ]);
    expect(http.requests[0]).toMatchObject({ url: "https://api.openai.com/v1/models", method: "GET" });
  });
});

describe("Anthropic adapter", () => {
  const point = accessPoint({ type: "anthropic", endpoint: ANTHROPIC_MESSAGES_URL, model: "claude-opus-5-5", apiKey: "sk-ant-key" });

  function message(content: unknown[], stopReason = "end_turn"): Handler {
    return () => jsonResponse({ id: "msg_1", type: "message", role: "assistant", content, stop_reason: stopReason, stop_details: null });
  }

  it("sends the documented Messages request with the browser access header", async () => {
    const { http, deps: d } = deps(message([{ type: "thinking", thinking: "" }, { type: "text", text: "0.97" }]));
    expect(await scoreAnthropic(point, PROMPT, PAYLOAD, d)).toBe(0.97);
    const sent = http.requests[0];
    expect(sent?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent?.headers["x-api-key"]).toBe("sk-ant-key");
    expect(sent?.headers["anthropic-version"]).toBe("2026-10-21");
    expect(sent?.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(sent?.json).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 4096,
      system: `${PROMPT}\n\n${OUTPUT_LINE}`,
      messages: [{ role: "user", content: PAYLOAD }],
      output_config: { effort: "low" },
    });
  });

  it("sends no sampling parameters and no thinking configuration", async () => {
    const { http, deps: d } = deps(message([{ type: "text", text: "0" }]));
    await scoreAnthropic(point, PROMPT, PAYLOAD, d);
    for (const field of ["temperature", "top_p", "top_k", "thinking"]) {
      expect(http.requests[0]?.json).not.toHaveProperty(field);
    }
  });

  it("checks the stop reason before reading the content", async () => {
    const refused = deps(message([{ type: "text", text: "0.9" }], "refusal"));
    expect((await failure(scoreAnthropic(point, PROMPT, PAYLOAD, refused.deps))).message).toContain("refused");
    const cut = deps(message([{ type: "text", text: "0.9" }], "max_tokens"));
    expect((await failure(scoreAnthropic(point, PROMPT, PAYLOAD, cut.deps))).message).toContain("cut off");
  });

  it("fails on output that is not just a number", async () => {
    for (const content of [[{ type: "text", text: "Probably spam: 0.9" }], [], [{ type: "thinking", thinking: "0.9" }]]) {
      const { deps: d } = deps(message(content));
      expect((await failure(scoreAnthropic(point, PROMPT, PAYLOAD, d))).kind).toBe("transient");
    }
  });

  it("classifies API errors", async () => {
    const error = (type: string, status: number, headers: Record<string, string> = {}): Handler => () =>
      jsonResponse({ type: "error", error: { type, message: `${type} happened` }, request_id: "req_1" }, status, headers);
    expect((await failure(scoreAnthropic(point, PROMPT, PAYLOAD, deps(error("authentication_error", 401)).deps))).kind).toBe("auth");
    expect((await failure(scoreAnthropic(point, PROMPT, PAYLOAD, deps(error("permission_error", 403)).deps))).kind).toBe("auth");
    expect(await failure(scoreAnthropic(point, PROMPT, PAYLOAD, deps(error("rate_limit_error", 429, { "retry-after": "12" })).deps))).toMatchObject({
      kind: "quota",
      retryAfterMs: 12_000,
    });
    expect((await failure(scoreAnthropic(point, PROMPT, PAYLOAD, deps(error("billing_error", 402)).deps))).kind).toBe("quota");
    expect((await failure(scoreAnthropic(point, PROMPT, PAYLOAD, deps(error("overloaded_error", 529)).deps))).kind).toBe("transient");
    expect((await failure(scoreAnthropic(point, PROMPT, PAYLOAD, deps(error("invalid_request_error", 400)).deps))).kind).toBe("transient");
  });
});

describe("presets and definitions", () => {
  it("ships the endpoints of the specification", () => {
    const byId = Object.fromEntries(PRESETS.map((preset) => [preset.id, preset]));
    expect(byId.jev).toMatchObject({ type: "systemone", endpoint: "https://api.typesafe.ai/v1/systemone" });
    expect(byId["openrouter-decisions"]).toMatchObject({ type: "systemone", endpoint: "https://openrouter.ai/api/alpha/decisions" });
    expect(byId["cloudflare-clef"]).toMatchObject({
      type: "systemone",
      endpoint: "https://api.cloudflare.com/client/v4/accounts/<account id>/ai/run/@cf/cloudflare/clef",
    });
    expect(byId["local-systemone"]).toMatchObject({ type: "systemone", endpoint: "http://localhost:8000/v1/systemone" });
    expect(byId["openai-decisions"]).toMatchObject({ type: "openai-decisions", endpoint: "https://api.openai.com/v1/decisions", model: "gpt-6-luna" });
    expect(byId.openai).toMatchObject({ type: "openai-chat", endpoint: "https://api.openai.com/v1" });
    expect(byId.gemini).toMatchObject({ type: "openai-chat", endpoint: "https://generativelanguage.googleapis.com/v1beta/openai" });
    expect(byId.openrouter).toMatchObject({ type: "openai-chat", endpoint: "https://openrouter.ai/api/v1" });
    expect(byId.ollama).toMatchObject({ type: "openai-chat", endpoint: "http://localhost:11434/v1" });
    expect(byId.lmstudio).toMatchObject({ type: "openai-chat", endpoint: "http://localhost:1234/v1" });
    expect(byId.custom).toMatchObject({ type: "openai-chat", endpoint: "" });
    expect(byId.anthropic).toMatchObject({ type: "anthropic", endpoint: "https://api.anthropic.com/v1/messages" });
    expect(byId.chatgpt).toMatchObject({ type: "chatgpt", endpoint: "https://api.openai.com/v1/responses" });
    expect(new Set(PRESETS.map((preset) => preset.id)).size).toBe(PRESETS.length);
  });

  it("only uses https endpoints, except on loopback addresses", () => {
    for (const preset of PRESETS) {
      if (preset.endpoint === "" || preset.endpoint.includes("<")) {
        continue;
      }
      expect(validateEndpoint(preset.endpoint), preset.id).toMatchObject({ ok: true });
    }
  });

  it("checks a definition before it is saved", () => {
    const base = { type: "openai-chat" as const, name: "Mine", enabled: true, endpoint: "https://api.example.com/v1", model: "m" };
    expect(checkDefinition(base, false)).toEqual([]);
    expect(checkDefinition({ ...base, name: " " }, false)).toEqual(["name-missing"]);
    expect(checkDefinition({ ...base, endpoint: "http://api.example.com/v1" }, false)).toEqual(["endpoint-insecure"]);
    expect(checkDefinition({ ...base, endpoint: "nonsense" }, false)).toEqual(["endpoint-invalid"]);
    expect(checkDefinition({ ...base, model: "" }, false)).toEqual(["model-missing"]);
    expect(checkDefinition({ ...base, type: "systemone", model: "" }, false)).toEqual([]);
    expect(checkDefinition({ ...base, type: "anthropic" }, false)).toEqual(["key-missing"]);
    expect(checkDefinition({ ...base, type: "anthropic" }, true)).toEqual([]);
    const cloudflare = PRESETS.find((preset) => preset.id === "cloudflare-clef");
    expect(checkDefinition({ ...base, type: "systemone", endpoint: cloudflare?.endpoint ?? "" }, true)).toEqual(["endpoint-placeholder"]);
  });

  it("fixes the endpoint of provider-bound types", () => {
    expect(normalizeDefinition({ type: "anthropic", name: " Claude ", enabled: true, endpoint: "https://evil.example", model: " claude-opus-5-5 " })).toEqual({
      type: "anthropic",
      name: "Claude",
      enabled: true,
      endpoint: "https://api.anthropic.com/v1/messages",
      model: "claude-opus-5-5",
    });
    expect(Object.keys(FIXED_ENDPOINTS).sort()).toEqual(["anthropic", "chatgpt", "openai-decisions"]);
    const point = newAccessPoint("id1", { type: "openai-chat", name: "X", enabled: true, endpoint: " https://a.example/v1 ", model: "m" }, "key");
    expect(point).toEqual({
      id: "id1",
      type: "openai-chat",
      name: "X",
      enabled: true,
      endpoint: "https://a.example/v1",
      model: "m",
      apiKey: "key",
      auth: null,
      cooldownUntil: 0,
      needsAttention: false,
      lastError: "",
    } satisfies AccessPoint);
  });
});

describe("adapter registry", () => {
  it("dispatches by type and refuses insecure endpoints", async () => {
    const http = fakeFetch((request) => {
      if (request.url.endsWith("/chat/completions")) {
        return jsonResponse({ choices: [{ message: { content: "0.2" } }] });
      }
      if (request.url.endsWith("/systemone")) {
        return jsonResponse({ answers: { spam: { type: "noul", noul: 0.4 } } });
      }
      if (request.url.endsWith("/decisions")) {
        return jsonResponse({ answers: [{ type: "predicate", name: "spam", probability: 0.6 }] });
      }
      return jsonResponse({ content: [{ type: "text", text: "0.8" }], stop_reason: "end_turn" });
    });
    const ai = createAi({ fetch: http.fetch, now: () => NOW, persist: async () => undefined, hasHostPermission: async () => true });
    expect(await ai.score(accessPoint({ type: "openai-chat" }), PROMPT, PAYLOAD)).toBe(0.2);
    expect(await ai.score(accessPoint({ type: "systemone", endpoint: "https://api.typesafe.ai/v1/systemone" }), PROMPT, PAYLOAD)).toBe(0.4);
    expect(await ai.score(accessPoint({ type: "openai-decisions", endpoint: OPENAI_DECISIONS_URL }), PROMPT, PAYLOAD)).toBe(0.6);
    expect(await ai.score(accessPoint({ type: "anthropic", endpoint: ANTHROPIC_MESSAGES_URL }), PROMPT, PAYLOAD)).toBe(0.8);

    const before = http.requests.length;
    const insecure = await failure(ai.score(accessPoint({ type: "openai-chat", endpoint: "http://remote.example/v1" }), PROMPT, PAYLOAD));
    expect(insecure.kind).toBe("transient");
    expect(http.requests.length).toBe(before);
    expect(await ai.listModels(accessPoint({ type: "systemone" }))).toEqual([]);
  });

  it("sends nothing to a host without a granted host permission", async () => {
    const http = fakeFetch(() => jsonResponse({ choices: [{ message: { content: "0.2" } }], data: [{ id: "m" }] }));
    const asked: string[] = [];
    const granted = new Set(["https://api.example.com/*"]);
    const ai = createAi({
      fetch: http.fetch,
      now: () => NOW,
      persist: async () => undefined,
      hasHostPermission: async (pattern) => {
        asked.push(pattern);
        return granted.has(pattern);
      },
    });
    expect(await ai.score(accessPoint({ type: "openai-chat" }), PROMPT, PAYLOAD)).toBe(0.2);

    const collector = accessPoint({ type: "openai-chat", endpoint: "https://collector.example/v1" });
    const refused = await failure(ai.score(collector, PROMPT, PAYLOAD));
    expect(refused.kind).toBe("auth");
    expect(refused.message).toContain("https://collector.example/*");
    expect((await failure(ai.listModels(collector))).kind).toBe("auth");
    expect(http.requests).toHaveLength(1);

    // Provider-bound types are checked for the host they really contact, whatever the stored endpoint says.
    asked.length = 0;
    await failure(ai.score(accessPoint({ type: "anthropic", endpoint: "https://api.example.com/v1" }), PROMPT, PAYLOAD));
    expect(asked).toEqual(["https://api.anthropic.com/*"]);
    asked.length = 0;
    await failure(ai.score(accessPoint({ type: "chatgpt", endpoint: CHATGPT_RESPONSES_URL, model: "m" }), PROMPT, PAYLOAD));
    expect(asked).toEqual(["https://auth.openai.com/*"]);
    expect(requiredOrigins(accessPoint({ type: "chatgpt" }))).toEqual(["https://auth.openai.com/*", "https://api.openai.com/*"]);
    expect(requiredOrigins(accessPoint({ type: "systemone", endpoint: "http://localhost:8000/v1/systemone" }))).toEqual(["http://localhost/*"]);
    expect(requiredOrigins(accessPoint({ type: "systemone", endpoint: "http://remote.example/v1" }))).toBeNull();
    expect(http.requests).toHaveLength(1);
  });
});
