// Anthropic Messages API: Claude with an API key.
//
// Raw HTTP on purpose: the add-on has one runtime dependency (tldts) and bundles no
// SDK. The request is the documented Messages API shape.

import { DIAGNOSTICS } from "../core/diagnostics";
import { AccessPointError } from "../core/chain";
import { llmInstructions, parseLlmScore } from "../core/score";
import type { AccessPoint } from "../core/types";
import { postJson, statusError } from "./http";
import type { FetchLike } from "./http";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2026-10-21";
/** Room for the model's thinking plus the short answer. A hard limit on total output. */
const MAX_TOKENS = 16000;
/**
 * Thinking cannot be switched off on current models, so its depth is set by the effort.
 * Medium is the owner's choice for the default model, Claude Sonnet 5.5.
 */
const EFFORT = "medium";
/**
 * Models whose safety classifiers can decline a request (stop reason "refusal") and that
 * accept the server-side fallback: the API then runs the same request on another model
 * inside the same call. Spam is often phishing or a malware lure, which is what such
 * classifiers look for. Other models are sent the plain request.
 */
const FALLBACK_MODELS: ReadonlySet<string> = new Set([
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-2",
  "claude-fable-5-1",
]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export async function scoreAnthropic(
  point: AccessPoint,
  prompt: string,
  payload: string,
  deps: { fetch: FetchLike; now: () => number },
): Promise<number> {
  const withFallback = FALLBACK_MODELS.has(point.model);
  const response = await postJson(
    deps.fetch,
    ANTHROPIC_MESSAGES_URL,
    {
      "x-api-key": point.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      // The request comes from an add-on page and carries an Origin header. The API
      // accepts such requests only with this header.
      "anthropic-dangerous-direct-browser-access": "true",
      ...(withFallback ? { "anthropic-beta": FALLBACK_BETA } : {}),
    },
    {
      model: point.model,
      max_tokens: MAX_TOKENS,
      system: llmInstructions(prompt),
      messages: [{ role: "user", content: payload }],
      output_config: { effort: EFFORT },
      // "default" lets the API choose the fallback model by the kind of refusal.
      ...(withFallback ? { fallbacks: "default" } : {}),
    },
  );
  if (!response.ok) {
    throw statusError(response.status, response.body, response.retryAfter, deps.now(), [point.apiKey]);
  }
  const body = response.body as { stop_reason?: unknown; content?: unknown } | null;
  // Always check the stop reason before reading the content. A refusal here means that
  // the model and, where one was asked for, its fallback both declined.
  if (body?.stop_reason === "refusal") {
    throw new AccessPointError("transient", DIAGNOSTICS.refused);
  }
  if (body?.stop_reason === "max_tokens") {
    throw new AccessPointError("transient", DIAGNOSTICS.cutOff);
  }
  const blocks = Array.isArray(body?.content) ? body.content : [];
  const text = blocks
    .map((block) =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
  const score = parseLlmScore(text);
  if (score === null) {
    throw new AccessPointError("transient", DIAGNOSTICS.notNumber);
  }
  return score;
}
