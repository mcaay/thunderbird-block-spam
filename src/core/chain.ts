// The AI chain: access points are tried in order and the first valid score is final.

import type { AccessPoint } from "./types";

export const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 30 * 1000;

/**
 * How an access point failed.
 * - transient: network error, timeout, HTTP 5xx, refusal or invalid output. The next access point is tried.
 * - quota: HTTP 429 or a quota error. The access point is skipped until retryAfterMs has passed, or for 10 minutes.
 * - auth: HTTP 401 or 403. The access point needs attention and is skipped until the user edits it.
 */
export type FailureKind = "transient" | "quota" | "auth";

export class AccessPointError extends Error {
  readonly kind: FailureKind;
  readonly retryAfterMs: number | null;

  constructor(kind: FailureKind, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "AccessPointError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ChainAttempt {
  accessPoint: string;
  error: string;
}

export interface ChainResult {
  /** Null when no access point is enabled or all of them failed. */
  verdict: { score: number; accessPoint: string } | null;
  /** True when at least one access point is enabled. */
  available: boolean;
  attempts: ChainAttempt[];
  /** True when the temporary state of an access point changed and must be stored. */
  stateChanged: boolean;
}

export function isAvailable(point: AccessPoint, now: number): boolean {
  return point.enabled && !point.needsAttention && point.cooldownUntil <= now;
}

/**
 * Runs the chain. Mutates cooldownUntil, needsAttention and lastError of the given
 * access points; the caller stores them when stateChanged is true.
 */
export async function runChain(
  points: AccessPoint[],
  score: (point: AccessPoint) => Promise<number>,
  now: () => number,
): Promise<ChainResult> {
  const result: ChainResult = {
    verdict: null,
    available: points.some((point) => point.enabled),
    attempts: [],
    stateChanged: false,
  };
  for (const point of points) {
    if (!isAvailable(point, now())) {
      continue;
    }
    try {
      const value = await score(point);
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new AccessPointError("transient", "invalid score");
      }
      if (point.lastError !== "" || point.cooldownUntil !== 0) {
        point.lastError = "";
        point.cooldownUntil = 0;
        result.stateChanged = true;
      }
      result.verdict = { score: value, accessPoint: point.name };
      return result;
    } catch (error) {
      const failure =
        error instanceof AccessPointError
          ? error
          : new AccessPointError("transient", error instanceof Error ? error.message : String(error));
      result.attempts.push({ accessPoint: point.name, error: failure.message });
      point.lastError = failure.message;
      if (failure.kind === "quota") {
        point.cooldownUntil = now() + (failure.retryAfterMs ?? DEFAULT_COOLDOWN_MS);
      } else if (failure.kind === "auth") {
        point.needsAttention = true;
      }
      result.stateChanged = true;
    }
  }
  return result;
}
