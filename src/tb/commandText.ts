// What a block or trust command says: the lines that report what it did, and the sentence
// that says beforehand what it would do. Both name exactly what changes on the lists, so
// that nothing changes that is not said.

import type { CommandName } from "../core/commandNames";
import type { CommandOutcome, CommandPreview } from "../core/engine";
import { t, tCode } from "./i18n";

const NOTIFICATION_TARGETS = 5;

function listed(values: readonly string[]): string {
  const shown = values.slice(0, NOTIFICATION_TARGETS).join(", ");
  return values.length > NOTIFICATION_TARGETS ? t("notifyMore", shown, values.length - NOTIFICATION_TARGETS) : shown;
}

/** What a command did, one fact per line. */
export function commandLines(outcome: CommandOutcome): string[] {
  const { plan } = outcome;
  const lines: string[] = [];
  if (plan.targets.length > 0) {
    lines.push(
      t(
        plan.list === "black" ? "notifyBlocked" : "notifyTrusted",
        listed(plan.targets.map((target) => target.value)),
      ),
    );
  }
  if (plan.lifted.length > 0) {
    // Entries of the other list that would still have decided a sender were removed: the line names them.
    lines.push(
      t(
        plan.list === "black" ? "notifyLiftedWhite" : "notifyLiftedBlack",
        listed(plan.lifted.map((entry) => entry.value)),
      ),
    );
  }
  if (plan.unknownSenders > 0) {
    lines.push(t("notifyUnknownSender", plan.unknownSenders));
  }
  if (outcome.moved > 0) {
    lines.push(t(plan.list === "black" ? "notifyMovedToJunk" : "notifyMovedToInbox", outcome.moved));
  }
  if (plan.ignoredOwn > 0) {
    lines.push(t("notifyOwnIgnored", plan.ignoredOwn));
  }
  const failure = outcome.failures[0];
  if (failure !== undefined) {
    const text = failure === "no-junk-folder" ? tCode("reason", failure) : failure === "no-inbox-folder" ? t("notifyNoInbox") : failure;
    lines.push(t("notifyMoveFailed", text));
  }
  if (lines.length === 0) {
    lines.push(t("notifyNothingChanged"));
  }
  return lines;
}

/**
 * What a command would do, in sentences, as the tooltip of its button: the entry it puts on its list, the entries
 * of the other list it removes because they would still decide the sender, and where the message goes.
 */
export function commandTitle(command: CommandName, preview: CommandPreview | undefined): string {
  if (preview === undefined) {
    return "";
  }
  const block = command.startsWith("block");
  const parts: string[] = [];
  if (preview.change !== "none") {
    parts.push(t(block ? "tipBlock" : "tipTrust", preview.target.value));
  }
  if (preview.lifted.length > 0) {
    parts.push(
      t(
        block ? "tipLiftWhite" : "tipLiftBlack",
        preview.lifted.map((entry) => entry.value).join(", "),
      ),
    );
  }
  if (preview.moves) {
    parts.push(t(block ? "tipMoveJunk" : "tipMoveInbox"));
  }
  return parts.join(" ");
}
