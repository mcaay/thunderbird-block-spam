// What the settings page knows about problems and about the state of protection. Every
// pane and the category list read them from here, so that they cannot disagree.

import { entriesFromArray, whiteListIsOnlyIdentities } from "../core/lists";
import { actsOnUnknownSenders, findProblems, protectionState, scanIsComplete, unknownSenderEffects } from "../core/problems";
import type { Problem, ProtectionState, UnknownSenderEffects } from "../core/problems";
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

/** What acts on unknown senders as the page is set up: an AI service that is switched on, and where mail without a verdict is moved. */
export function effectsOf(model: Model): UnknownSenderEffects {
  return model.settings === null ? { sent: false, moved: null } : unknownSenderEffects(model.settings, model.accessPoints);
}

/**
 * With nothing learned, mail from existing contacts would be sent to an AI service, moved, or both: what would
 * happen to it. Null when nothing would, so that there is nothing to ask "scan first" about.
 */
export function beforeScan(model: Model): UnknownSenderEffects | null {
  const effects = effectsOf(model);
  return nothingLearned(model) && actsOnUnknownSenders(effects) ? effects : null;
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
