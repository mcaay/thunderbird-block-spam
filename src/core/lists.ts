// White list and black list: entries, uniqueness and matching.

import { SCOPE_ALL } from "./types";
import type { Entry, EntryKind, EntrySource, ListName, Scope, Sender } from "./types";

/** Both lists in one map. A key exists at most once across both lists. */
export type EntryMap = Map<string, Entry>;

export type AddResult = "added" | "moved" | "unchanged" | "source-updated";

export interface NewEntry {
  list: ListName;
  kind: EntryKind;
  value: string;
  scope: Scope;
  source: EntrySource;
}

export function entryKey(kind: EntryKind, value: string, scope: Scope): string {
  return `${kind} ${scope} ${value}`;
}

export function keyOf(entry: Pick<Entry, "kind" | "value" | "scope">): string {
  return entryKey(entry.kind, entry.value, entry.scope);
}

export function entriesFromArray(entries: readonly Entry[]): EntryMap {
  const map: EntryMap = new Map();
  for (const entry of entries) {
    map.set(keyOf(entry), entry);
  }
  return map;
}

/**
 * Adds an entry. Adding a key to one list removes it from the other. Adding a key
 * that already exists in the same list changes nothing, except that a manual add
 * sets its source to manual.
 */
export function addEntry(map: EntryMap, entry: NewEntry, now: number): AddResult {
  const key = keyOf(entry);
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, { ...entry, addedAt: now });
    return "added";
  }
  if (existing.list !== entry.list) {
    map.set(key, { ...entry, addedAt: now });
    return "moved";
  }
  if (entry.source === "manual" && existing.source !== "manual") {
    map.set(key, { ...existing, source: "manual" });
    return "source-updated";
  }
  return "unchanged";
}

export function removeEntry(map: EntryMap, key: string): boolean {
  return map.delete(key);
}

/**
 * Finds the entry that decides a sender in an account. Order: address scoped to the
 * account, address scoped to all, domain scoped to the account, domain scoped to all.
 * Returns null when the sender is unknown.
 */
export function matchSender(map: EntryMap, sender: Sender, accountId: string): Entry | null {
  return (
    map.get(entryKey("address", sender.address, accountId)) ??
    map.get(entryKey("address", sender.address, SCOPE_ALL)) ??
    map.get(entryKey("domain", sender.domain, accountId)) ??
    map.get(entryKey("domain", sender.domain, SCOPE_ALL)) ??
    null
  );
}

/** True when the white list holds nothing but the user's own addresses. */
export function whiteListIsOnlyIdentities(map: EntryMap): boolean {
  for (const entry of map.values()) {
    if (entry.list === "white" && entry.source !== "identity") {
      return false;
    }
  }
  return true;
}
