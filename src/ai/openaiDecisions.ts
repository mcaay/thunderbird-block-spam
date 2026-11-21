// OpenAI Decisions API (gpt-6-luna): one predicate question named "spam".

import { DIAGNOSTICS } from "../core/diagnostics";
import { AccessPointError } from "../core/chain";
import { parseProbability } from "../core/score";
import type { AccessPoint } from "../core/types";
import { postJson, statusError } from "./http";
import type { FetchLike } from "./http";

export const OPENAI_DECISIONS_URL = "https://api.openai.com/v1/decisions";
const QUESTION_NAME = "spam";

export async function scoreOpenAiDecisions(
  point: AccessPoint,
  prompt: string,
  payload: string,
  deps: { fetch: FetchLike; now: () => number },
): Promise<number> {
  const response = await postJson(
    deps.fetch,
    OPENAI_DECISIONS_URL,
    { authorization: `Bearer ${point.apiKey}` },
    {
      model: point.model,
      input: payload,
      questions: [{ type: "predicate", name: QUESTION_NAME, instructions: prompt }],
    },
  );
  if (!response.ok) {
    throw statusError(response.status, response.body, response.retryAfter, deps.now(), [point.apiKey]);
  }
  const answers = (response.body as { answers?: unknown } | null)?.answers;
  const answer = Array.isArray(answers) ? (answers[0] as Record<string, unknown> | undefined) : undefined;
  if (typeof answer !== "object" || answer === null) {
    throw new AccessPointError("transient", DIAGNOSTICS.answerMissing);
  }
  if (answer.type === "refusal") {
    throw new AccessPointError("transient", DIAGNOSTICS.refused);
  }
  const score = parseProbability(answer.probability);
  if (score === null) {
    throw new AccessPointError("transient", DIAGNOSTICS.notProbability);
  }
  return score;
}
