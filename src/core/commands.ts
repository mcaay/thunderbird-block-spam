// Shortcut commands: block and trust, by address or by domain.

import { smartTarget } from "./address";
import type { CommandName } from "./commandNames";
import type { EffectiveSender } from "./forward";
import { entryKey, keyOf, matchSender } from "./lists";
import type { EntryMap } from "./lists";
import type { AppState } from "./state";
import { SCOPE_ALL } from "./types";
import type { Entry, ListName, MessageInfo, Scope, Sender, Target } from "./types";

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
  /**
   * Entries of the other list that were removed because they would still have decided a sender (an address entry
   * beats a domain entry, an entry of the account one for all accounts), in order, without duplicates. The line
   * that reports the command names them, so that nothing changes that is not said.
   */
  lifted: Entry[];
  /** Messages to move to Junk (block) or to the Inbox (trust). */
  moves: MessageInfo[];
  /** Messages sent by one of the user's own addresses. They are ignored. */
  ignoredOwn: number;
  /** Messages whose effective sender could not be determined: moved, but no entry added. */
  unknownSenders: number;
  entriesChanged: boolean;
  /** How to take the list changes back: keys to remove, and entries to put back exactly as they were. */
  undo: { remove: string[]; restore: Entry[] };
}

/** What a command would change on the lists for one sender. */
export interface CommandEffect {
  target: Target;
  scope: Scope;
  /** added: a new entry. moved: the entry is on the other list now. none: it is on this list already. */
  change: "added" | "moved" | "none";
  /** Entries of the other list that still decide the sender once the target is on its list: the command removes them. */
  lifted: Entry[];
}

/**
 * What a command would change on the lists for a sender of an account, without changing anything. The command
 * is the user's newest decision about this sender, so it always takes effect: an older entry of the other list
 * that would still decide the sender is removed.
 */
export function commandEffect(
  state: Pick<AppState, "settings" | "publicDomains" | "entries">,
  command: CommandName,
  sender: Sender,
  accountId: string,
): CommandEffect {
  const list: ListName = command.startsWith("block") ? "black" : "white";
  const target = commandTarget(state, command, sender);
  const scope: Scope = state.settings.newEntryScope === "shared" ? SCOPE_ALL : accountId;
  const key = entryKey(target.kind, target.value, scope);
  const existing = state.entries.get(key);
  const after: EntryMap = new Map(state.entries);
  after.set(key, { list, kind: target.kind, value: target.value, scope, source: "manual", addedAt: 0 });
  const lifted: Entry[] = [];
  for (;;) {
    const deciding = matchSender(after, sender, accountId);
    if (deciding === null || deciding.list === list) {
      break;
    }
    lifted.push(deciding);
    after.delete(keyOf(deciding));
  }
  return { target, scope, change: existing === undefined ? "added" : existing.list === list ? "none" : "moved", lifted };
}

/** The entry a command adds for a sender, and whether the command works on the domain. */
export function commandTarget(
  state: Pick<AppState, "settings" | "publicDomains">,
  command: CommandName,
  sender: Sender,
): Target {
  if (!command.endsWith("domain")) {
    return { kind: "address", value: sender.address };
  }
  return state.settings.smart ? smartTarget(sender, state.publicDomains) : { kind: "domain", value: sender.domain };
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
  const plan: CommandPlan = {
    list,
    targets: [],
    lifted: [],
    moves: [],
    ignoredOwn: 0,
    unknownSenders: 0,
    entriesChanged: false,
    undo: { remove: [], restore: [] },
  };
  const seen = new Set<string>();
  /** Every key the command touches, with the entry that held it before. The first touch counts. */
  const before = new Map<string, Entry | undefined>();
  const touch = (key: string): void => {
    if (!before.has(key)) {
      before.set(key, state.entries.get(key));
    }
  };

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
      const target = commandTarget(state, command, sender);
      const scope = state.newEntryScope(item.message.accountId);
      touch(entryKey(target.kind, target.value, scope));
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
        touch(keyOf(deciding));
        state.removeEntry(keyOf(deciding));
        plan.entriesChanged = true;
        if (!plan.lifted.some((entry) => keyOf(entry) === keyOf(deciding))) {
          plan.lifted.push(deciding);
        }
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
  for (const [key, original] of before) {
    const current = state.entries.get(key);
    if (original === undefined) {
      if (current !== undefined) {
        plan.undo.remove.push(key);
      }
    } else if (current !== original) {
      plan.undo.restore.push(original);
    }
  }
  return plan;
}
