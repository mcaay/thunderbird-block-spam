// What waits for a scan of the sent mail: "switch protection on", and AI services that
// are to be switched on. Whichever comes second, protection or the first AI service, asks
// "scan first", and the thing that waits is switched on when the scan has finished
// without an error. The wish is kept in storage, so it survives a closed settings page
// and a restart of Thunderbird. When the scan was cancelled or could not read a folder,
// the wish is dropped and the page says why.

export type WishOutcomeKind = "on" | "cancelled" | "errors";

export interface WishOutcome {
  /** on: the scan finished and what waited was switched on. Otherwise why it was not. */
  kind: WishOutcomeKind;
  /** When the scan ended. */
  at: number;
  /** How many messages the scan read. */
  scanned: number;
}

/** What became of AI services that waited: the outcome, and the services it was about. */
export interface ServicesOutcome extends WishOutcome {
  ids: string[];
}

export interface ScanRange {
  since: number;
  from: number | null;
  to: number | null;
}

export interface ProtectionWish {
  /** Set while protection waits for a scan: since when, and the dates the scan is limited to. */
  waiting: ScanRange | null;
  /** What became of the last wish. Kept until the user has seen it or switches protection again. */
  outcome: WishOutcome | null;
  /** Set while AI services wait for a scan: which ones, since when, and the dates the scan is limited to. */
  services: (ScanRange & { ids: string[] }) | null;
  /** What became of the services that waited. Kept until the user has seen it, switches one of them or starts the next scan. */
  servicesOutcome: ServicesOutcome | null;
}

export const NO_WISH: ProtectionWish = { waiting: null, outcome: null, services: null, servicesOutcome: null };

/** True when nothing waits and nothing is left to say: the wish need not be stored. */
export function isNoWish(wish: ProtectionWish): boolean {
  return wish.waiting === null && wish.outcome === null && wish.services === null && wish.servicesOutcome === null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isLimit(value: unknown): value is number | null {
  return value === null || isTime(value);
}

function readRange(value: unknown): ScanRange | null {
  return isRecord(value) && isTime(value.since) && isLimit(value.from) && isLimit(value.to) ? { since: value.since, from: value.from, to: value.to } : null;
}

function readOutcome(value: unknown): WishOutcome | null {
  return isRecord(value) && (value.kind === "on" || value.kind === "cancelled" || value.kind === "errors") && isTime(value.at) && isTime(value.scanned)
    ? { kind: value.kind, at: value.at, scanned: value.scanned }
    : null;
}

function readIds(value: unknown): string[] | null {
  if (!isRecord(value) || !Array.isArray(value.ids)) {
    return null;
  }
  const ids = value.ids.filter((id): id is string => typeof id === "string" && id !== "");
  return ids.length === 0 ? null : [...new Set(ids)];
}

/** The wish as stored. Anything that is not one counts as no wish: nothing is switched on because of data that cannot be read. */
export function readWish(raw: unknown): ProtectionWish {
  if (!isRecord(raw)) {
    return NO_WISH;
  }
  const servicesRange = readRange(raw.services);
  const servicesIds = readIds(raw.services);
  const servicesOutcome = readOutcome(raw.servicesOutcome);
  const outcomeIds = readIds(raw.servicesOutcome);
  return {
    waiting: readRange(raw.waiting),
    outcome: readOutcome(raw.outcome),
    services: servicesRange !== null && servicesIds !== null ? { ...servicesRange, ids: servicesIds } : null,
    servicesOutcome: servicesOutcome !== null && outcomeIds !== null ? { ...servicesOutcome, ids: outcomeIds } : null,
  };
}

/** What a scan that has ended makes of a wish that waited for it. */
export function outcomeOfScan(scan: { cancelled: boolean; errors: readonly string[]; scanned: number }, now: number): WishOutcome {
  return { kind: scan.cancelled ? "cancelled" : scan.errors.length > 0 ? "errors" : "on", at: now, scanned: scan.scanned };
}

/** The services that wait, without the given one. Null when none is left. */
export function withoutService(services: ProtectionWish["services"], id: string): ProtectionWish["services"] {
  if (services === null) {
    return null;
  }
  const ids = services.ids.filter((other) => other !== id);
  return ids.length === 0 ? null : { ...services, ids };
}

/** The outcome of the services that waited, without the given one. Null when none is left. */
export function outcomeWithoutService(outcome: ServicesOutcome | null, id: string): ServicesOutcome | null {
  if (outcome === null) {
    return null;
  }
  const ids = outcome.ids.filter((other) => other !== id);
  return ids.length === 0 ? null : { ...outcome, ids };
}
