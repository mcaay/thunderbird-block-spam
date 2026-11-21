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
const MAX_TOKENS = 4096;

export async function scoreAnthropic(
  point: AccessPoint,
  prompt: string,
  payload: string,
  deps: { fetch: FetchLike; now: () => number },
): Promise<number> {
  const response = await postJson(
    deps.fetch,
    ANTHROPIC_MESSAGES_URL,
    {
      "x-api-key": point.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      // The request comes from an add-on page and carries an Origin header. The API
      // accepts such requests only with this header.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    {
      model: point.model,
      max_tokens: MAX_TOKENS,
      system: llmInstructions(prompt),
      messages: [{ role: "user", content: payload }],
      // Classification does well at low effort and thinking cannot be switched off
      // on current models.
      output_config: { effort: "low" },
    },
  );
  if (!response.ok) {
    throw statusError(response.status, response.body, response.retryAfter, deps.now(), [point.apiKey]);
  }
  const body = response.body as { stop_reason?: unknown; content?: unknown } | null;
  // Always check the stop reason before reading the content.
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
