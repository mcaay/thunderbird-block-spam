// Undoing a logged decision where it is seen: trust or block the sender of one log entry.

import { parseSender, smartTarget } from "./address";
import { entryKey, keyOf, matchSender } from "./lists";
import type { AddResult } from "./lists";
import { ValidationError } from "./settings";
import type { AppState } from "./state";
import type { Entry, ListName, LogEntry, Scope, Target } from "./types";

export const LOG_ACTIONS = ["trust", "block"] as const;
export type LogAction = (typeof LOG_ACTIONS)[number];

export function isLogAction(value: unknown): value is LogAction {
  return typeof value === "string" && (LOG_ACTIONS as readonly string[]).includes(value);
}

/**
 * The action that undoes a logged decision, or null when the entry offers none: a
 * test score decides nothing, and without a sender or a Message-ID there is nothing
 * to act on (entries logged by older versions have no Message-ID).
 *
 * A decision against the sender (the message was moved, or would have been in
 * observation mode) is undone by trusting, every other decision by blocking.
 */
export function fittingAction(entry: Pick<LogEntry, "outcome" | "action" | "test" | "sender" | "messageId">): LogAction | null {
  if (entry.test || entry.sender === "" || entry.messageId === "" || entry.outcome === "error") {
    return null;
  }
  if (entry.outcome === "spam" || entry.outcome === "blocked") {
    return "trust";
  }
  if (entry.outcome === "no-verdict") {
    return entry.action === "junk" || entry.action === "screening" ? "trust" : "block";
  }
  return "block";
}

/**
 * Whether the action also moves the message. Trusting moves it back only when the
 * decision really moved it: an observed decision moved nothing. Blocking always
 * moves it to Junk.
 */
export function expectsMove(entry: Pick<LogEntry, "action" | "observed" | "test">, action: LogAction): boolean {
  if (entry.test) {
    return false;
  }
  return action === "block" || ((entry.action === "junk" || entry.action === "screening") && !entry.observed);
}

/**
 * What the action adds to the lists.
 * - trust: the smart target of the sender, the exact inverse of what the AI does when
 *   it blocks. A wrongly blocked company is trusted as a whole, an address at a public
 *   provider alone.
 * - block: the smart target, but only the address while a white list entry decides the
 *   sender or the decision was "trusted": a blocked address stays blocked inside a
 *   trusted domain, and the domain keeps its trust.
 */
export function logActionTarget(
  state: Pick<AppState, "entries" | "publicDomains">,
  entry: Pick<LogEntry, "accountId" | "sender" | "outcome">,
  action: LogAction,
): Target | null {
  const sender = parseSender(entry.sender);
  if (sender === null) {
    return null;
  }
  if (action === "block") {
    const deciding = matchSender(state.entries, sender, entry.accountId);
    if (entry.outcome === "trusted" || entry.outcome === "released" || deciding?.list === "white") {
      return { kind: "address", value: sender.address };
    }
  }
  return smartTarget(sender, state.publicDomains);
}

export interface LogActionPlan {
  list: ListName;
  target: Target;
  scope: Scope;
  result: AddResult;
  /** How to take the list change back: keys to remove, and entries to put back exactly as they were. */
  undo: { remove: string[]; restore: Entry[] };
}

/**
 * Applies the list change of an action in memory; the caller stores the entries and
 * then moves the message. The entry has the source manual, and as with a shortcut the
 * action always takes effect: an older entry of the other list that would still decide
 * this sender is removed.
 */
export function applyLogAction(
  state: AppState,
  entry: Pick<LogEntry, "accountId" | "sender" | "outcome">,
  action: LogAction,
  ownAddresses: ReadonlySet<string>,
  now: number,
): LogActionPlan {
  const sender = parseSender(entry.sender);
  const target = logActionTarget(state, entry, action);
  if (sender === null || target === null) {
    throw new ValidationError("entry.sender: not an address", "no-sender");
  }
  if (ownAddresses.has(sender.address)) {
    throw new ValidationError("entry.sender: one of the user's own addresses", "own-address");
  }
  const list: ListName = action === "trust" ? "white" : "black";
  const scope = state.newEntryScope(entry.accountId);
  const key = entryKey(target.kind, target.value, scope);
  const previous = state.entries.get(key);
  const undo: LogActionPlan["undo"] = { remove: [], restore: [] };

  const result = state.addEntry({ list, kind: target.kind, value: target.value, scope, source: "manual" }, now);
  if (result !== "unchanged") {
    if (previous === undefined) {
      undo.remove.push(key);
    } else {
      undo.restore.push(previous);
    }
  }
  for (;;) {
    const deciding = matchSender(state.entries, sender, entry.accountId);
    if (deciding === null || deciding.list === list) {
      break;
    }
    undo.restore.push(deciding);
    state.removeEntry(keyOf(deciding));
  }
  return { list, target, scope, result, undo };
}
