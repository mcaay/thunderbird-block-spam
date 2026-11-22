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

/** What became of "switch protection on" after the scan it waited for. */
export function wishOutcomeText(outcome: WishOutcome): string {
  if (outcome.kind === "on") {
    return t(outcome.scanned === 0 ? "wishOnEmpty" : "wishOn");
  }
  return t(outcome.kind === "cancelled" ? "wishCancelled" : "wishErrors");
}
