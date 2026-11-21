// Shortcut commands: block and trust, by address or by domain.

import { smartTarget } from "./address";
import type { CommandName } from "./commandNames";
import type { EffectiveSender } from "./forward";
import { keyOf, matchSender } from "./lists";
import type { AppState } from "./state";
import type { ListName, MessageInfo, Target } from "./types";

export { COMMANDS, isCommandName } from "./commandNames";
export type { CommandName } from "./commandNames";

export interface CommandMessage {
  message: MessageInfo;
  effective: EffectiveSender;
  /** Where the message is now. */
  location: "junk" | "screening" | "other";
}

export interface CommandPlan {
  list: ListName;
  /** Entries that were added or changed, in order, without duplicates. */
  targets: Target[];
  /** Messages to move to Junk (block) or to the Inbox (trust). */
  moves: MessageInfo[];
  /** Messages sent by one of the user's own addresses. They are ignored. */
  ignoredOwn: number;
  /** Messages whose effective sender could not be determined: moved, but no entry added. */
  unknownSenders: number;
  entriesChanged: boolean;
}

/**
 * Applies a command to the selected messages. Entries are changed in memory; the
 * caller stores them and then performs the moves.
 *
 * The address commands always use the address. The domain commands use the smart
 * target when Smart is on, otherwise always the registrable domain.
 */
export function applyCommand(
  state: AppState,
  command: CommandName,
  selected: readonly CommandMessage[],
  ownAddresses: ReadonlySet<string>,
  now: number,
): CommandPlan {
  const list: ListName = command.startsWith("block") ? "black" : "white";
  const byDomain = command.endsWith("domain");
  const plan: CommandPlan = { list, targets: [], moves: [], ignoredOwn: 0, unknownSenders: 0, entriesChanged: false };
  const seen = new Set<string>();

  for (const item of selected) {
    const sender = item.effective.sender;
    if (sender !== null && ownAddresses.has(sender.address)) {
      plan.ignoredOwn += 1;
      continue;
    }
    if (sender === null) {
      // The effective sender could not be determined: the message is only moved.
      plan.unknownSenders += 1;
    } else {
      const target: Target = !byDomain
        ? { kind: "address", value: sender.address }
        : state.settings.smart
          ? smartTarget(sender, state.publicDomains)
          : { kind: "domain", value: sender.domain };
      const scope = state.newEntryScope(item.message.accountId);
      const result = state.addEntry({ list, kind: target.kind, value: target.value, scope, source: "manual" }, now);
      if (result !== "unchanged") {
        plan.entriesChanged = true;
      }
      // The command is the user's newest decision about this sender. An older entry
      // of the other list that would still decide this sender is removed.
      for (;;) {
        const deciding = matchSender(state.entries, sender, item.message.accountId);
        if (deciding === null || deciding.list === list) {
          break;
        }
        state.removeEntry(keyOf(deciding));
        plan.entriesChanged = true;
      }
      const label = `${target.kind} ${target.value}`;
      if (!seen.has(label)) {
        seen.add(label);
        plan.targets.push(target);
      }
    }

    if (list === "black") {
      if (item.location !== "junk") {
        plan.moves.push(item.message);
      }
    } else if (item.location === "junk" || item.location === "screening") {
      plan.moves.push(item.message);
    }
  }
  return plan;
}
