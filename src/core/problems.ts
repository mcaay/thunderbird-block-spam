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
  /** True while the white list holds nothing but the user's own addresses. */
  onlyOwnAddresses: boolean;
  now: number;
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
