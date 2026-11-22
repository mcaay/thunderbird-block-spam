// What the settings page, the popup and the toolbar button say about problems and about
// protection that waited for a scan, in the same words everywhere.

import type { Problem, UnknownSenderEffects } from "../core/problems";
import type { MovingAction, WishOutcome } from "../core/protectionWish";
import type { AccessPoint } from "../core/types";
import { t, tCode } from "./i18n";

/** The problems by their short names, as one phrase: "no Junk folder; AI service not used: OpenAI". */
export function problemNames(problems: readonly Problem[], accessPoints: readonly Pick<AccessPoint, "id" | "name">[]): string {
  return problems
    .map((problem) =>
      problem.kind === "attention"
        ? tCode("cause", problem.kind, problem.accessPointIds.map((id) => accessPoints.find((point) => point.id === id)?.name ?? id).join(", "))
        : tCode("cause", problem.kind),
    )
    .join("; ");
}

/** The same problems, one per line, each starting with a capital letter: for the popup, which has the room. */
export function problemLines(problems: readonly Problem[], accessPoints: readonly Pick<AccessPoint, "id" | "name">[], locale: string): string[] {
  return problems.map((problem) => {
    const name = problemNames([problem], accessPoints);
    return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  });
}

/** What became of "switch protection on" after the scan it waited for. */
export function wishOutcomeText(outcome: WishOutcome): string {
  if (outcome.kind === "on") {
    return t(outcome.scanned === 0 ? "wishOnEmpty" : "wishOn");
  }
  return t(outcome.kind === "cancelled" ? "wishCancelled" : "wishErrors");
}

/**
 * What became of AI services that waited for the scan, with their names. `afterProtection`: the sentence follows
 * the one about protection, which has already said how the scan ended.
 */
export function servicesOutcomeText(outcome: WishOutcome, names: readonly string[], afterProtection = false): string {
  const many = names.length > 1;
  const list = names.join(", ");
  if (outcome.kind === "on") {
    if (afterProtection) {
      return t(many ? "servicesAlsoOnMany" : "servicesAlsoOn", list);
    }
    return outcome.scanned === 0 ? t(many ? "servicesWishOnEmptyMany" : "servicesWishOnEmpty", list) : t(many ? "servicesWishOnMany" : "servicesWishOn", list);
  }
  if (afterProtection) {
    return t(many ? "servicesAlsoNotOnMany" : "servicesAlsoNotOn", list);
  }
  return outcome.kind === "cancelled" ? t(many ? "servicesWishCancelledMany" : "servicesWishCancelled", list) : t(many ? "servicesWishErrorsMany" : "servicesWishErrors", list);
}

/** Where mail is moved, as the end of a sentence: "to the Spam folder", "to a screening folder". */
export function whereText(moved: MovingAction): string {
  return t(moved === "junk" ? "whereJunk" : "whereScreening");
}

/**
 * What happens to mail from people the user already writes to while the sent mail is not scanned, by what acts on
 * unknown senders: it is sent to the AI service, moved, or both. `on`: protection is on, so it happens now ("is");
 * otherwise it would. Empty when nothing acts.
 */
export function beforeScanText(effects: UnknownSenderEffects, on: boolean): string {
  if (effects.sent) {
    const sent = t(on ? "warnAiBeforeScanOn" : "warnAiBeforeScan");
    return effects.moved === null ? sent : `${sent} ${t(on ? "warnBeforeScanAlsoMovedOn" : "warnBeforeScanAlsoMoved", whereText(effects.moved))}`;
  }
  return effects.moved === null ? "" : t(on ? "warnBeforeScanMovedOn" : "warnBeforeScanMoved", whereText(effects.moved));
}

/** The first paragraph of "Scan your sent mail first?": what would happen to mail from existing contacts without the scan. */
export function scanFirstReason(effects: UnknownSenderEffects): string {
  if (effects.sent) {
    return beforeScanText(effects, false);
  }
  return effects.moved === null ? "" : t("scanFirstMoved", whereText(effects.moved));
}

/** The text of "Wait for the scan to finish?" before protection is switched on, by what acts on unknown senders. */
export function scanWaitReason(effects: UnknownSenderEffects): string {
  if (effects.moved === null) {
    return t("scanWaitText");
  }
  return t(effects.sent ? "scanWaitBothText" : "scanWaitMovedText", whereText(effects.moved));
}

/**
 * What became of the choice to move mail without an AI verdict after the scan it waited for. `afterOther`: the
 * sentence follows one about protection or the services, which has already said how the scan ended.
 */
export function noVerdictOutcomeText(outcome: WishOutcome, action: MovingAction, afterOther = false): string {
  if (outcome.kind === "on") {
    return t(afterOther ? "noVerdictAlsoOn" : outcome.scanned === 0 ? "noVerdictWishOnEmpty" : "noVerdictWishOn", whereText(action));
  }
  return t(afterOther ? "noVerdictAlsoNotOn" : outcome.kind === "cancelled" ? "noVerdictWishCancelled" : "noVerdictWishErrors");
}
