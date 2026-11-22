// Undoing a logged decision where it is seen: trust or block the sender of one log entry.

import { parseSender, smartTarget } from "./address";
import { entryKey, keyOf, matchSender } from "./lists";
import type { EntryMap } from "./lists";
import { ValidationError } from "./settings";
import type { AppState } from "./state";
import type { Entry, ListName, LogEntry, Scope, Sender, Target } from "./types";

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
 * What an action changes on the lists.
 * - add: an entry is added, and nothing else changes.
 * - move: the entry that decides the sender moves to the other list, with its kind, value and scope.
 * - remove: the black entry that decides the sender is removed, and the white entry behind it decides from then on.
 * - none: the lists already say what the action wants. Only the message may still move.
 */
export type LogChange = "add" | "move" | "remove" | "none";

export interface LogOffer {
  action: LogAction;
  change: LogChange;
  list: ListName;
  /** The entry that is added, moved or removed, or for "none" the entry that already decides. */
  target: Target;
  scope: Scope;
  /** For "remove": the white entry that decides once the black one is gone. */
  behind: Entry | null;
}

/** The entry that decides the sender when the given entry is left out. */
function decidingWithout(entries: EntryMap, sender: Sender, accountId: string, without: Entry): Entry | null {
  const rest: EntryMap = new Map(entries);
  rest.delete(keyOf(without));
  return matchSender(rest, sender, accountId);
}

/**
 * What an action of a log row would change, given the lists as they are now. A command never changes more than its
 * label says, so the action works on the entry that decided:
 * - The lists already say it (trust while a white entry decides, block while a black one does): nothing changes.
 * - trust while a black entry decides: that entry moves to the white list, as an address or as a domain, whichever it
 *   is. A block of one address is undone for that address, not by trusting its whole domain. When a white entry
 *   decides the sender once the black one is gone (a blocked address inside a trusted domain), the black entry is
 *   only removed.
 * - block while a white address entry decides: that entry moves to the black list.
 * - block while a white domain entry decides, or after a decision that trusted the sender: only the address is added
 *   to the black list. A blocked address stays blocked inside a trusted domain, and the domain keeps its trust.
 * - No entry decides (an observed AI verdict, a move without a verdict, a sender that passed): the smart target is
 *   added, the exact inverse of what the AI does when it blocks. A company goes on the list as a whole, an address
 *   at a public provider alone.
 * Null when the entry has no sender to act on.
 */
export function logOffer(
  state: { entries: EntryMap; publicDomains: ReadonlySet<string>; newEntryScope: (accountId: string) => Scope },
  entry: Pick<LogEntry, "accountId" | "sender" | "outcome">,
  action: LogAction,
): LogOffer | null {
  const sender = parseSender(entry.sender);
  if (sender === null) {
    return null;
  }
  const list: ListName = action === "trust" ? "white" : "black";
  const deciding = matchSender(state.entries, sender, entry.accountId);
  const of = (found: Entry): Target => ({ kind: found.kind, value: found.value });
  if (deciding !== null && deciding.list === list) {
    return { action, change: "none", list, target: of(deciding), scope: deciding.scope, behind: null };
  }
  if (deciding !== null && action === "trust") {
    const behind = decidingWithout(state.entries, sender, entry.accountId, deciding);
    return behind?.list === "white"
      ? { action, change: "remove", list, target: of(deciding), scope: deciding.scope, behind }
      : { action, change: "move", list, target: of(deciding), scope: deciding.scope, behind: null };
  }
  if (deciding !== null && deciding.kind === "address") {
    return { action, change: "move", list, target: of(deciding), scope: deciding.scope, behind: null };
  }
  const scope = state.newEntryScope(entry.accountId);
  if (action === "block" && (deciding !== null || entry.outcome === "trusted" || entry.outcome === "released")) {
    return { action, change: "add", list, target: { kind: "address", value: sender.address }, scope, behind: null };
  }
  return { action, change: "add", list, target: smartTarget(sender, state.publicDomains), scope, behind: null };
}

export interface LogActionPlan extends LogOffer {
  /** How to take the list change back: keys to remove, and entries to put back exactly as they were. */
  undo: { remove: string[]; restore: Entry[] };
}

/**
 * Applies the list change of an action in memory; the caller stores the entries and
 * then moves the message. An entry that is added or moved has the source manual. What
 * changes is exactly what logOffer says, and Undo takes exactly that back.
 */
export function applyLogAction(
  state: AppState,
  entry: Pick<LogEntry, "accountId" | "sender" | "outcome">,
  action: LogAction,
  ownAddresses: ReadonlySet<string>,
  now: number,
): LogActionPlan {
  const sender = parseSender(entry.sender);
  const offer = logOffer({ entries: state.entries, publicDomains: state.publicDomains, newEntryScope: (accountId) => state.newEntryScope(accountId) }, entry, action);
  if (sender === null || offer === null) {
    throw new ValidationError("entry.sender: not an address", "no-sender");
  }
  if (ownAddresses.has(sender.address)) {
    throw new ValidationError("entry.sender: one of the user's own addresses", "own-address");
  }
  const key = entryKey(offer.target.kind, offer.target.value, offer.scope);
  const previous = state.entries.get(key);
  const undo: LogActionPlan["undo"] = { remove: [], restore: [] };
  if (offer.change === "remove") {
    if (previous !== undefined) {
      undo.restore.push(previous);
      state.removeEntry(key);
      // The white entry behind it decides now: the sender's mail in a screening folder is released.
      state.whiteAdded = true;
    }
  } else if (offer.change !== "none") {
    state.addEntry({ list: offer.list, kind: offer.target.kind, value: offer.target.value, scope: offer.scope, source: "manual" }, now);
    if (previous === undefined) {
      undo.remove.push(key);
    } else {
      undo.restore.push(previous);
    }
  }
  return { ...offer, undo };
}
