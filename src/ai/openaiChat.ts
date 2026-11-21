// OpenAI-compatible chat completions: OpenAI, Gemini, OpenRouter, Ollama, LM Studio
// and any custom URL, including local bridges.

import { DIAGNOSTICS } from "../core/diagnostics";
import { AccessPointError } from "../core/chain";
import { llmInstructions, parseLlmScore } from "../core/score";
import type { AccessPoint } from "../core/types";
import { postJson, request, statusError } from "./http";
import type { FetchLike } from "./http";

export interface ModelOption {
  id: string;
  label: string;
}

function baseUrl(point: AccessPoint): string {
  return point.endpoint.replace(/\/+$/, "");
}

function authHeaders(point: AccessPoint): Record<string, string> {
  return point.apiKey === "" ? {} : { authorization: `Bearer ${point.apiKey}` };
}

/** Text of the first choice. Content may be a string or a list of text parts. */
function replyText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .join("");
  }
  return "";
}

export async function scoreOpenAiChat(
  point: AccessPoint,
  prompt: string,
  payload: string,
  deps: { fetch: FetchLike; now: () => number },
): Promise<number> {
  if (point.model === "") {
    throw new AccessPointError("transient", DIAGNOSTICS.noModelSet);
  }
  const response = await postJson(deps.fetch, `${baseUrl(point)}/chat/completions`, authHeaders(point), {
    model: point.model,
    messages: [
      { role: "system", content: llmInstructions(prompt) },
      { role: "user", content: payload },
    ],
  });
  if (!response.ok) {
    throw statusError(response.status, response.body, response.retryAfter, deps.now(), [point.apiKey]);
  }
  const choices = (response.body as { choices?: unknown } | null)?.choices;
  const choice = Array.isArray(choices) ? (choices[0] as Record<string, unknown> | undefined) : undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  if (typeof message !== "object" || message === null) {
    throw new AccessPointError("transient", DIAGNOSTICS.answerMissing);
  }
  if ((typeof message.refusal === "string" && message.refusal !== "") || choice?.finish_reason === "content_filter") {
    throw new AccessPointError("transient", DIAGNOSTICS.refused);
  }
  const score = parseLlmScore(replyText(message));
  if (score === null) {
    throw new AccessPointError("transient", DIAGNOSTICS.notNumber);
  }
  return score;
}

/** Models offered by an OpenAI-compatible endpoint (GET <base>/models). */
export async function listOpenAiChatModels(
  point: AccessPoint,
  deps: { fetch: FetchLike; now: () => number },
): Promise<ModelOption[]> {
  const response = await request(deps.fetch, `${baseUrl(point)}/models`, {
    method: "GET",
    headers: { accept: "application/json", ...authHeaders(point) },
  });
  if (!response.ok) {
    throw statusError(response.status, response.body, response.retryAfter, deps.now(), [point.apiKey]);
  }
  const data = (response.body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    return [];
  }
  return data
    .map((item) => (typeof item === "object" && item !== null ? (item as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === "string" && id !== "")
    .map((id) => ({ id: id.replace(/^models\//, ""), label: id.replace(/^models\//, "") }));
}
