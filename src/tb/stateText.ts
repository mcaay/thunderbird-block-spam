// What the settings page, the popup and the toolbar button say about problems and about
// protection that waited for a scan, in the same words everywhere.

import type { Problem } from "../core/problems";
import type { WishOutcome } from "../core/protectionWish";
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
