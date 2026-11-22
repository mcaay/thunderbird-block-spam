// What the settings page knows about problems and about the state of protection. Every
// pane and the category list read them from here, so that they cannot disagree.

import { entriesFromArray, whiteListIsOnlyIdentities } from "../core/lists";
import { findProblems, protectionState, scanIsComplete } from "../core/problems";
import type { Problem, ProtectionState } from "../core/problems";
import { hostGranted } from "./aiState";
import type { Model } from "./model";

/** Somebody but the user is on the white list. */
export function learned(model: Model): boolean {
  return !whiteListIsOnlyIdentities(entriesFromArray(model.entries));
}

/** Nobody but the user is on the white list, and no scan of this session ran to its end and found that there is nobody. */
export function nothingLearned(model: Model): boolean {
  return !learned(model) && !scanIsComplete(model.status.scan);
}

/** With AI switched on and nothing learned, mail from existing contacts would be scored. */
export function aiBeforeScan(model: Model): boolean {
  return model.accessPoints.some((point) => point.enabled) && nothingLearned(model);
}

/** The problems the Overview warns about, one per cause. None while stored data is invalid. */
export function problemsOf(model: Model): Problem[] {
  if (model.settings === null) {
    return [];
  }
  return findProblems({
    settings: model.settings,
    accessPoints: model.accessPoints,
    accounts: model.accounts,
    onlyOwnAddresses: nothingLearned(model),
    hostGranted,
    now: Date.now(),
  });
}

/** The state of protection and the number of problems behind it. */
export function stateOf(model: Model): { kind: ProtectionState; problems: number } {
  const settings = model.settings;
  const problems = problemsOf(model).length;
  const kind = protectionState({
    invalid: model.status.fatal !== null || settings === null,
    accounts: model.accounts.length,
    protection: settings?.protection === true,
    observation: settings?.observation === true,
    problems,
    waiting: model.status.wish.waiting,
  });
  return { kind, problems };
}
