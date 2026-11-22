// What currently keeps protection from working as set up, and the state of protection
// that follows from it. The settings page shows one warning with a fix per problem, and
// the popup and the toolbar button count and name them.

import { resolveMonitoredFolders } from "./folders";
import { aiHealth } from "./stats";
import type { AccessPoint, FolderRef, Settings } from "./types";

/** What is needed to know about an account. */
export interface AccountFacts {
  id: string;
  /** The Inbox folders of the account. */
  inboxes: FolderRef[];
  hasJunk: boolean;
}

export type Problem =
  /**
   * The sent mail was not scanned (the white list holds only the user's own addresses) while something acts on
   * unknown senders: until the scan, the people the user writes to count as such. One cause, whatever acts.
   */
  | ({ kind: "before-scan" } & UnknownSenderEffects)
  /** Monitored accounts without a Junk folder, so nothing can be moved there. */
  | { kind: "no-junk"; accountIds: string[] }
  /** AI services that are switched on and need the user for the same reason: a rejected key, a missing sign-in. */
  | { kind: "attention"; remedy: Remedy; accessPointIds: string[] }
  /** AI services are switched on, none of them would be asked now, and waiting can change that. */
  | { kind: "ai-down" }
  /** Mail without a verdict goes to a screening folder, but these monitored accounts have none. */
  | { kind: "no-screening"; accountIds: string[] };

/**
 * What acts on mail from unknown senders, the senders on neither list.
 * - sent: an AI service is switched on, so their mail is sent to it.
 * - moved: where their mail goes when no service gives a verdict, also with no AI service at all. Null: it stays.
 */
export interface UnknownSenderEffects {
  sent: boolean;
  moved: "junk" | "screening" | null;
}

export function unknownSenderEffects(settings: Pick<Settings, "noVerdictAction">, accessPoints: readonly Pick<AccessPoint, "enabled">[]): UnknownSenderEffects {
  return { sent: accessPoints.some((point) => point.enabled), moved: settings.noVerdictAction === "leave" ? null : settings.noVerdictAction };
}

/** True when something acts on unknown senders: before the sent mail is scanned, that asks "scan first". */
export function actsOnUnknownSenders(effects: UnknownSenderEffects): boolean {
  return effects.sent || effects.moved !== null;
}

/** The kinds of problems, as the codes of their short names. */
export const PROBLEM_KINDS = ["before-scan", "no-junk", "attention", "ai-down", "no-screening"] as const;

export interface ProblemInput {
  settings: Settings;
  accessPoints: readonly AccessPoint[];
  accounts: readonly AccountFacts[];
  /** True while the white list holds nothing but the user's own addresses and no scan has run to its end. */
  onlyOwnAddresses: boolean;
  /** False only for a service whose host this computer is known not to allow. Without it every host counts as allowed. */
  hostGranted?: (point: AccessPoint) => boolean;
  now: number;
}

/**
 * A scan that ran to its end without an error has put everyone the sent mail names on
 * the white list, also when that is nobody (a mailbox that has sent nothing yet). The
 * state of a scan is kept for the session only.
 */
export function scanIsComplete(scan: { running: boolean; cancelled: boolean; errors: readonly string[] } | null): boolean {
  return scan !== null && !scan.running && !scan.cancelled && scan.errors.length === 0;
}

/**
 * Where setup step 1, the scan of sent mail, stands.
 * - todo: nothing was learned yet and no scan ran in this session.
 * - running: a scan is in progress. The step is not done before it ends.
 * - incomplete: the last scan was cancelled or could not read a folder: it should run again.
 * - empty: the scan ran to its end and found no sent mail at all.
 * - done: the scan ran to its end, or contacts were learned before this session.
 */
export type ScanStep = "todo" | "running" | "incomplete" | "empty" | "done";

export function scanStep(
  scan: { running: boolean; cancelled: boolean; errors: readonly string[]; scanned: number } | null,
  learned: boolean,
): ScanStep {
  if (scan === null) {
    return learned ? "done" : "todo";
  }
  if (scan.running) {
    return "running";
  }
  if (!scanIsComplete(scan)) {
    return "incomplete";
  }
  return scan.scanned === 0 && !learned ? "empty" : "done";
}

/** Why a service needs attention, as the code of the sentence that says what to do about it. */
export type Remedy = "sign-in" | "permission" | "key-missing" | "key-rejected" | "plan-refused";

/** Whether a ChatGPT plan service holds a sign-in. */
export function signedIn(point: Pick<AccessPoint, "type" | "auth">): boolean {
  return point.type === "chatgpt" && point.auth !== null && point.auth.refreshToken !== "";
}

/**
 * What to do about a service that needs attention. `hostGranted` is false only when
 * this computer is known not to allow the host of the service.
 */
export function remedyFor(point: Pick<AccessPoint, "type" | "auth" | "apiKey" | "lastError">, hostGranted: boolean): Remedy {
  if (point.type === "chatgpt") {
    return signedIn(point) ? (hostGranted ? "plan-refused" : "permission") : "sign-in";
  }
  if (!hostGranted) {
    return "permission";
  }
  // An imported service arrives without its key and is marked until the key is entered.
  return point.apiKey === "" && point.lastError === "" ? "key-missing" : "key-rejected";
}

/**
 * The problems in the order the settings page lists them. One cause is one problem:
 * accounts that lack the same folder are named together, and so are services that
 * need the user for the same reason, because one remedy fits them all.
 */
export function findProblems(input: ProblemInput): Problem[] {
  const { settings, accessPoints, accounts, now } = input;
  const problems: Problem[] = [];
  const effects = unknownSenderEffects(settings, accessPoints);
  if (input.onlyOwnAddresses && actsOnUnknownSenders(effects)) {
    problems.push({ kind: "before-scan", ...effects });
  }
  const monitored = accounts.filter(
    (account) => resolveMonitoredFolders(account.inboxes, settings).some((folder) => folder.accountId === account.id),
  );
  const withoutJunk = monitored.filter((item) => !item.hasJunk).map((account) => account.id);
  if (withoutJunk.length > 0) {
    problems.push({ kind: "no-junk", accountIds: withoutJunk });
  }
  const byRemedy = new Map<Remedy, string[]>();
  for (const point of accessPoints.filter((item) => item.enabled && item.needsAttention)) {
    const remedy = remedyFor(point, input.hostGranted?.(point) ?? true);
    byRemedy.set(remedy, [...(byRemedy.get(remedy) ?? []), point.id]);
  }
  for (const [remedy, accessPointIds] of byRemedy) {
    problems.push({ kind: "attention", remedy, accessPointIds });
  }
  // A paused service comes back by itself. It is a problem only when no service is left.
  const health = aiHealth(accessPoints, now);
  if (health.enabled > 0 && health.working === 0 && accessPoints.some((point) => point.enabled && !point.needsAttention)) {
    problems.push({ kind: "ai-down" });
  }
  if (settings.noVerdictAction === "screening") {
    const withoutScreening = monitored.filter((item) => !settings.screeningFolders.some((folder) => folder.accountId === item.id)).map((account) => account.id);
    if (withoutScreening.length > 0) {
      problems.push({ kind: "no-screening", accountIds: withoutScreening });
    }
  }
  return problems;
}

/**
 * The state of protection, one at a time, the most important first. Every surface that
 * shows a state (the settings page, the popup, the tooltip of the toolbar button) shows this one.
 * - invalid: stored data failed validation. Protection is off and nothing is written.
 * - no-account: Thunderbird has no mail account, so there is no mail to protect.
 * - problems: protection is on and something keeps it from working as set up.
 * - waiting: protection is off and is switched on when the running scan has finished.
 * - observing: protection is on and only observes.
 */
export type ProtectionState = "invalid" | "no-account" | "problems" | "waiting" | "observing" | "on" | "off";

export const PROTECTION_STATES = ["invalid", "no-account", "problems", "waiting", "observing", "on", "off"] as const;

export function protectionState(facts: {
  /** Stored data failed validation. */
  invalid: boolean;
  /** How many mail accounts Thunderbird has. */
  accounts: number;
  protection: boolean;
  observation: boolean;
  /** How many problems findProblems lists. They count while protection is on. */
  problems: number;
  /** Protection waits for the scan, see ProtectionWish. */
  waiting: boolean;
}): ProtectionState {
  if (facts.invalid) {
    return "invalid";
  }
  if (facts.accounts === 0) {
    return "no-account";
  }
  if (facts.protection) {
    return facts.problems > 0 ? "problems" : facts.observation ? "observing" : "on";
  }
  return facts.waiting ? "waiting" : "off";
}
