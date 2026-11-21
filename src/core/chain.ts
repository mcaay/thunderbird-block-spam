// The AI chain: access points are tried in order and the first valid score is final.

import type { AccessPoint } from "./types";

export const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
/** A cool-down never lasts longer, whatever a server asks for. */
export const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
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

export interface ChainOptions {
  /**
   * Scores the built-in sample email. Some services answer 401 or 403 because of the
   * content of one request (a moderation filter), so an access point needs attention
   * only when it refuses the sample as well.
   */
  probe?: (point: AccessPoint) => Promise<number>;
  /** Asked before each access point. True ends the chain without a verdict, for example once the sender is on a list. */
  stop?: () => boolean;
}

/** At most a day, and always a number that can be stored and validated again. */
function cooldownMs(retryAfterMs: number | null): number {
  return retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? Math.min(retryAfterMs, MAX_COOLDOWN_MS)
    : DEFAULT_COOLDOWN_MS;
}

function asFailure(error: unknown): AccessPointError {
  return error instanceof AccessPointError
    ? error
    : new AccessPointError("transient", error instanceof Error ? error.message : String(error));
}

/**
 * Runs the chain. Mutates cooldownUntil, needsAttention and lastError of the given
 * access points; the caller stores them when stateChanged is true.
 */
export async function runChain(
  points: AccessPoint[],
  score: (point: AccessPoint) => Promise<number>,
  now: () => number,
  options: ChainOptions = {},
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
    if (options.stop?.() === true) {
      break;
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
      let failure = asFailure(error);
      result.attempts.push({ accessPoint: point.name, error: failure.message });
      point.lastError = failure.message;
      if (failure.kind === "auth" && options.probe !== undefined) {
        // The failure counts for this message only, unless the sample is refused too.
        failure = await options.probe(point).then(
          () => new AccessPointError("transient", failure.message),
          (probeError: unknown) => asFailure(probeError),
        );
      }
      if (failure.kind === "quota") {
        point.cooldownUntil = now() + cooldownMs(failure.retryAfterMs);
      } else if (failure.kind === "auth") {
        point.needsAttention = true;
      }
      result.stateChanged = true;
    }
  }
  return result;
}
