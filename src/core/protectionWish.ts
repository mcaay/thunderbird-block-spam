// "Switch protection on" that has to wait for a scan of the sent mail. The wish is kept
// in storage, so it survives a closed settings page and a restart of Thunderbird: when
// the scan has finished without an error protection is switched on, and when it was
// cancelled or could not read a folder the wish is dropped and the page says why.

export type WishOutcomeKind = "on" | "cancelled" | "errors";

export interface WishOutcome {
  /** on: the scan finished and protection was switched on. Otherwise why it was not. */
  kind: WishOutcomeKind;
  /** When the scan ended. */
  at: number;
  /** How many messages the scan read. */
  scanned: number;
}

export interface ProtectionWish {
  /** Set while protection waits for a scan: since when, and the dates the scan is limited to. */
  waiting: { since: number; from: number | null; to: number | null } | null;
  /** What became of the last wish. Kept until the user has seen it or switches protection again. */
  outcome: WishOutcome | null;
}

export const NO_WISH: ProtectionWish = { waiting: null, outcome: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isLimit(value: unknown): value is number | null {
  return value === null || isTime(value);
}

/** The wish as stored. Anything that is not one counts as no wish: nothing is switched on because of data that cannot be read. */
export function readWish(raw: unknown): ProtectionWish {
  if (!isRecord(raw)) {
    return NO_WISH;
  }
  const { waiting, outcome } = raw;
  const validWaiting = isRecord(waiting) && isTime(waiting.since) && isLimit(waiting.from) && isLimit(waiting.to);
  const validOutcome =
    isRecord(outcome) && (outcome.kind === "on" || outcome.kind === "cancelled" || outcome.kind === "errors") && isTime(outcome.at) && isTime(outcome.scanned);
  return {
    waiting: validWaiting ? { since: waiting.since as number, from: waiting.from as number | null, to: waiting.to as number | null } : null,
    outcome: validOutcome ? { kind: outcome.kind as WishOutcomeKind, at: outcome.at as number, scanned: outcome.scanned as number } : null,
  };
}

/** What a scan that has ended makes of a wish that waited for it. */
export function outcomeOfScan(scan: { cancelled: boolean; errors: readonly string[]; scanned: number }, now: number): WishOutcome {
  return { kind: scan.cancelled ? "cancelled" : scan.errors.length > 0 ? "errors" : "on", at: now, scanned: scan.scanned };
}
