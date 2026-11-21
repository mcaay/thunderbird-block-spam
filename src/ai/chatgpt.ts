// ChatGPT plan access point: the Responses API with an OAuth access token from
// "Sign in with ChatGPT". Requests set store: false and stream: true and are read
// until response.completed.

import { AccessPointError, REQUEST_TIMEOUT_MS } from "../core/chain";
import { llmInstructions, parseLlmScore } from "../core/score";
import type { AccessPoint, ChatGptAuth } from "../core/types";
import { needsRefresh, refreshTokens, revokeSession } from "./chatgptAuth";
import { errorCodeFromBody, errorMessageFromBody, parseRetryAfter, request, safeMessage, statusError, withTimeout } from "./http";
import type { FetchLike } from "./http";
import type { ModelOption } from "./openaiChat";

export const CHATGPT_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const CHATGPT_MODELS_URL = "https://api.openai.com/v1/models";

export interface ChatGptDeps {
  fetch: FetchLike;
  now: () => number;
  /** Stores the access points. Called after a token refresh, before the new token is used. */
  persist: () => Promise<void>;
}

/** One refresh at a time per access point, so a rotating refresh token is never used twice. */
const refreshes = new Map<string, Promise<void>>();

async function freshAccessToken(point: AccessPoint, deps: ChatGptDeps): Promise<string> {
  if (point.auth === null || point.auth.refreshToken === "") {
    throw new AccessPointError("auth", "not signed in");
  }
  if (needsRefresh(point.auth, deps.now())) {
    let running = refreshes.get(point.id);
    if (running === undefined) {
      running = (async () => {
        const current = point.auth;
        if (current === null) {
          throw new AccessPointError("auth", "not signed in");
        }
        let refreshed: ChatGptAuth;
        try {
          refreshed = await refreshTokens(deps.fetch, current, deps.now());
        } catch (error) {
          if (error instanceof AccessPointError && error.kind === "auth" && point.auth === current) {
            // The refresh token is unusable. Clear it and ask for a new sign-in.
            point.auth = { ...current, accessToken: "", refreshToken: "", expiresAt: 0 };
            await deps.persist();
          }
          throw error;
        }
        if (point.auth !== current) {
          // Signed out, signed in again or removed while the refresh ran: the session it
          // renewed is over, so the new tokens are never used and their session is ended.
          await revokeSession(deps.fetch, refreshed);
          throw new AccessPointError("auth", "not signed in");
        }
        point.auth = refreshed;
        // Refresh tokens rotate: the replacement is stored before it is used.
        await deps.persist();
      })().finally(() => refreshes.delete(point.id));
      refreshes.set(point.id, running);
    }
    await running;
  }
  const token = point.auth?.accessToken ?? "";
  if (token === "") {
    throw new AccessPointError("auth", "not signed in");
  }
  return token;
}

/** Maps the documented plan-usage error codes to chain failures. */
function planError(code: string, message: string, status: number, retryAfter: string | null, now: number): AccessPointError {
  const text = safeMessage(message === "" ? code : message);
  if (code === "subscription_sharing_usage_limit_exceeded") {
    return new AccessPointError("quota", `usage limit reached: ${text}`, parseRetryAfter(retryAfter, now));
  }
  if (code === "subscription_sharing_usage_unavailable" || code === "subscription_sharing_user_unavailable") {
    return new AccessPointError("transient", text);
  }
  if (
    code === "subscription_sharing_user_not_eligible" ||
    code === "subscription_sharing_invalid_user" ||
    code === "subscription_sharing_route_not_supported" ||
    code.startsWith("chatpass_v2_")
  ) {
    return new AccessPointError("auth", text);
  }
  return statusError(status, message === "" ? code : `${code}: ${message}`, retryAfter, now);
}

/** Parses a server-sent event stream and calls onEvent with each JSON payload. Stops when onEvent returns true. */
export async function readEventStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: Record<string, unknown>) => boolean,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (block: string): boolean => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data === "" || data === "[DONE]") {
      return false;
    }
    try {
      const parsed = JSON.parse(data) as unknown;
      return typeof parsed === "object" && parsed !== null ? onEvent(parsed as Record<string, unknown>) : false;
    } catch {
      return false;
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
        if (flush(block)) {
          return;
        }
        boundary = buffer.search(/\r?\n\r?\n/);
      }
      if (done) {
        if (buffer.trim() !== "") {
          flush(buffer);
        }
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function scoreChatGpt(point: AccessPoint, prompt: string, payload: string, deps: ChatGptDeps): Promise<number> {
  if (point.model === "") {
    throw new AccessPointError("transient", "no model is selected");
  }
  const token = await freshAccessToken(point, deps);
  const text = await withTimeout(REQUEST_TIMEOUT_MS, async (signal) => {
    const response = await deps.fetch(CHATGPT_RESPONSES_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        model: point.model,
        instructions: llmInstructions(prompt),
        input: [{ role: "user", content: payload }],
        store: false,
        stream: true,
      }),
      signal,
    });
    if (!response.ok) {
      const raw = await response.text();
      let body: unknown = raw;
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        body = raw;
      }
      throw planError(
        errorCodeFromBody(body),
        safeMessage(errorMessageFromBody(body), [token]),
        response.status,
        response.headers.get("retry-after"),
        deps.now(),
      );
    }
    if (response.body === null) {
      throw new AccessPointError("transient", "the answer is empty");
    }
    let output = "";
    let completed = false;
    let failure: AccessPointError | null = null;
    await readEventStream(response.body, (event) => {
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        output += event.delta;
        return false;
      }
      if (event.type === "response.completed") {
        completed = true;
        return true;
      }
      if (event.type === "response.failed" || event.type === "error") {
        const error = (event.type === "error" ? event : (event.response as { error?: unknown } | undefined)?.error) as
          | { code?: unknown; message?: unknown }
          | undefined;
        failure = planError(
          typeof error?.code === "string" ? error.code : "",
          typeof error?.message === "string" ? safeMessage(error.message, [token]) : "the request failed",
          500,
          null,
          deps.now(),
        );
        return true;
      }
      if (event.type === "response.incomplete") {
        failure = new AccessPointError("transient", "the answer is incomplete");
        return true;
      }
      return false;
    });
    if (failure !== null) {
      throw failure as AccessPointError;
    }
    if (!completed) {
      throw new AccessPointError("transient", "the answer ended early");
    }
    return output;
  });
  const score = parseLlmScore(text);
  if (score === null) {
    throw new AccessPointError("transient", "the answer is not a number from 0.00 to 1.00");
  }
  return score;
}

/** The model catalog of the signed-in account: models meant for display, in the server's order. */
export async function listChatGptModels(point: AccessPoint, deps: ChatGptDeps): Promise<ModelOption[]> {
  const token = await freshAccessToken(point, deps);
  const response = await request(deps.fetch, CHATGPT_MODELS_URL, {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!response.ok) {
    throw planError(
      errorCodeFromBody(response.body),
      safeMessage(errorMessageFromBody(response.body), [token]),
      response.status,
      response.retryAfter,
      deps.now(),
    );
  }
  const body = response.body as { models?: unknown; data?: unknown } | null;
  if (Array.isArray(body?.models)) {
    return body.models
      .filter((model): model is { slug: string; display_name?: unknown; visibility?: unknown } =>
        typeof model === "object" && model !== null && typeof (model as { slug?: unknown }).slug === "string",
      )
      .filter((model) => model.visibility === "list")
      .map((model) => ({
        id: model.slug,
        label: typeof model.display_name === "string" && model.display_name !== "" ? model.display_name : model.slug,
      }));
  }
  if (Array.isArray(body?.data)) {
    return body.data
      .map((model) => (typeof model === "object" && model !== null ? (model as { id?: unknown }).id : null))
      .filter((id): id is string => typeof id === "string" && id !== "")
      .map((id) => ({ id, label: id }));
  }
  return [];
}
