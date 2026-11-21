// Score parsing. The only thing that can come out of the AI is a number from 0.00 to 1.00.

/** The fixed line appended to the prompt for the three LLM access point types. */
export const OUTPUT_LINE = "Reply with only a number between 0.00 and 1.00: the probability that the answer is yes.";

export const DEFAULT_CUTOFF = 0.85;

/** Prompt plus the fixed output line, as sent to LLMs. */
export function llmInstructions(prompt: string): string {
  return `${prompt.trim()}\n\n${OUTPUT_LINE}`;
}

/** Rounds to two decimals. */
export function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Parses an LLM reply. The trimmed reply must be 0, 1, or a number between them
 * with one or two decimals. Anything else returns null.
 */
export function parseLlmScore(reply: string): number | null {
  const text = reply.trim();
  if (!/^(0|1|0\.\d{1,2}|1\.0{1,2})$/.test(text)) {
    return null;
  }
  return roundScore(Number(text));
}

/** Validates a probability returned by a decision model. Returns null when it is not a number from 0 to 1. */
export function parseProbability(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return null;
  }
  return roundScore(value);
}

/** A message is spam when its score is greater than the cutoff. */
export function isSpam(score: number, cutoff: number): boolean {
  return score > cutoff;
}
