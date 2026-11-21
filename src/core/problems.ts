// What currently keeps protection from working as set up. The settings page shows one
// warning with a fix per problem, and the popup counts them.

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
  /** An AI service is on while the white list holds only the user's own addresses. */
  | { kind: "ai-before-scan" }
  /** A monitored account has no Junk folder, so nothing can be moved there. */
  | { kind: "no-junk"; accountId: string }
  /** An AI service that is switched on needs the user: a rejected key, a missing sign-in. */
  | { kind: "attention"; accessPointId: string }
  /** AI services are switched on, none of them would be asked now, and waiting can change that. */
  | { kind: "ai-down" }
  /** Mail without a verdict goes to a screening folder, but a monitored account has none. */
  | { kind: "no-screening"; accountId: string };

export interface ProblemInput {
  settings: Settings;
  accessPoints: readonly AccessPoint[];
  accounts: readonly AccountFacts[];
  /** True while the white list holds nothing but the user's own addresses and no scan has run to its end. */
  onlyOwnAddresses: boolean;
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

/** The problems in the order the settings page lists them. */
export function findProblems(input: ProblemInput): Problem[] {
  const { settings, accessPoints, accounts, now } = input;
  const problems: Problem[] = [];
  if (input.onlyOwnAddresses && accessPoints.some((point) => point.enabled)) {
    problems.push({ kind: "ai-before-scan" });
  }
  const monitored = accounts.filter(
    (account) => resolveMonitoredFolders(account.inboxes, settings).some((folder) => folder.accountId === account.id),
  );
  for (const account of monitored.filter((item) => !item.hasJunk)) {
    problems.push({ kind: "no-junk", accountId: account.id });
  }
  for (const point of accessPoints.filter((item) => item.enabled && item.needsAttention)) {
    problems.push({ kind: "attention", accessPointId: point.id });
  }
  // A paused service comes back by itself. It is a problem only when no service is left.
  const health = aiHealth(accessPoints, now);
  if (health.enabled > 0 && health.working === 0 && accessPoints.some((point) => point.enabled && !point.needsAttention)) {
    problems.push({ kind: "ai-down" });
  }
  if (settings.noVerdictAction === "screening") {
    for (const account of monitored.filter((item) => !settings.screeningFolders.some((folder) => folder.accountId === item.id))) {
      problems.push({ kind: "no-screening", accountId: account.id });
    }
  }
  return problems;
}
