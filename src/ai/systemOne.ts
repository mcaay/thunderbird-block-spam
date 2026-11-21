// System One decision models: Jev (TypeSafe), Cloudflare Clef, OpenRouter decisions,
// local basal and Bielik-One. One noul question named "spam".

import { AccessPointError } from "../core/chain";
import { parseProbability } from "../core/score";
import type { AccessPoint } from "../core/types";
import { postJson, statusError } from "./http";
import type { FetchLike } from "./http";

export const QUESTION_NAME = "spam";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Reads answers.spam from the response, also when nested under "result" as Cloudflare's REST API does. */
export function readSystemOneAnswer(body: unknown): Record<string, unknown> | null {
  const root = asRecord(body);
  if (root === null) {
    return null;
  }
  for (const candidate of [root, asRecord(root.result)]) {
    const answer = asRecord(asRecord(candidate?.answers)?.[QUESTION_NAME]);
    if (answer !== null) {
      return answer;
    }
  }
  return null;
}

export async function scoreSystemOne(
  point: AccessPoint,
  prompt: string,
  payload: string,
  deps: { fetch: FetchLike; now: () => number },
): Promise<number> {
  const body: Record<string, unknown> = {
    state: payload,
    questions: { [QUESTION_NAME]: { type: "noul", instructions: prompt } },
  };
  if (point.model !== "") {
    body.model = point.model;
  }
  const headers: Record<string, string> = {};
  if (point.apiKey !== "") {
    headers.authorization = `Bearer ${point.apiKey}`;
  }
  const response = await postJson(deps.fetch, point.endpoint, headers, body);
  if (!response.ok) {
    throw statusError(response.status, response.body, response.retryAfter, deps.now(), [point.apiKey]);
  }
  const answer = readSystemOneAnswer(response.body);
  if (answer === null) {
    throw new AccessPointError("transient", "the answer is missing");
  }
  if (answer.type === "refusal") {
    throw new AccessPointError("transient", "the model refused to answer");
  }
  const score = parseProbability(answer.noul);
  if (score === null) {
    throw new AccessPointError("transient", "the answer is not a probability");
  }
  return score;
}
