// White list learning from recipients and identities. Headers only, no AI.

import { parseSender, smartTarget } from "./address";
import { addEntry, entryKey, keyOf, matchSender } from "./lists";
import type { EntryMap } from "./lists";
import { SCOPE_ALL } from "./types";
import type { Scope } from "./types";

export interface LearnContext {
  entries: EntryMap;
  publicDomains: ReadonlySet<string>;
  /** The user's own addresses, normalized. */
  ownAddresses: ReadonlySet<string>;
  /** Account of the sent message. */
  accountId: string;
  /** Scope of new entries: "all" or the account id, from the "new entries" setting. */
  scope: Scope;
  source: "sent" | "scan";
  now: number;
}

export type LearnStatus =
  | "added" // a new white list entry
  | "replaced" // a black list entry with the same key was replaced
  | "known" // the white list entry already existed
  | "own" // one of the user's own addresses
  | "manual-block" // a manual black list entry covers the recipient
  | "invalid"; // not an address

/**
 * Learns one recipient. A manual black list entry for the address or for its domain
 * (scoped to all or to the account) blocks learning. In every other case the smart
 * target is whitelisted.
 */
export function learnRecipient(ctx: LearnContext, rawAddress: string): LearnStatus {
  const recipient = parseSender(rawAddress);
  if (recipient === null) {
    return "invalid";
  }
  if (ctx.ownAddresses.has(recipient.address)) {
    return "own";
  }
  for (const scope of new Set([ctx.accountId, SCOPE_ALL])) {
    for (const key of [
      entryKey("address", recipient.address, scope),
      entryKey("domain", recipient.domain, scope),
    ]) {
      const entry = ctx.entries.get(key);
      if (entry !== undefined && entry.list === "black" && entry.source === "manual") {
        return "manual-block";
      }
    }
  }
  const target = smartTarget(recipient, ctx.publicDomains);
  const result = addEntry(
    ctx.entries,
    { list: "white", kind: target.kind, value: target.value, scope: ctx.scope, source: ctx.source },
    ctx.now,
  );
  // The user's own correspondence outranks an AI verdict, also one with another key
  // that would still decide this recipient: an account-scoped entry while new entries
  // are shared, or an address entry from when the domain was public. Manual blocks
  // were excluded above and are never touched.
  let removed = false;
  for (;;) {
    const deciding = matchSender(ctx.entries, recipient, ctx.accountId);
    if (deciding === null || deciding.list === "white" || deciding.source !== "ai") {
      break;
    }
    ctx.entries.delete(keyOf(deciding));
    removed = true;
  }
  if (result === "added") {
    return "added";
  }
  if (result === "moved" || removed) {
    return "replaced";
  }
  return "known";
}

export interface LearnSummary {
  /** New or replaced white list entries. */
  changed: number;
}

export function learnRecipients(ctx: LearnContext, rawAddresses: readonly string[]): LearnSummary {
  let changed = 0;
  for (const raw of rawAddresses) {
    const status = learnRecipient(ctx, raw);
    if (status === "added" || status === "replaced") {
      changed += 1;
    }
  }
  return { changed };
}

/**
 * Adds the user's own addresses as smart targets (source identity, scope all)
 * whenever no entry with that key exists yet in either list.
 */
export function syncIdentities(
  entries: EntryMap,
  ownAddresses: Iterable<string>,
  publicDomains: ReadonlySet<string>,
  now: number,
): number {
  let added = 0;
  for (const raw of ownAddresses) {
    const own = parseSender(raw);
    if (own === null) {
      continue;
    }
    const target = smartTarget(own, publicDomains);
    if (entries.has(entryKey(target.kind, target.value, SCOPE_ALL))) {
      continue;
    }
    addEntry(
      entries,
      { list: "white", kind: target.kind, value: target.value, scope: SCOPE_ALL, source: "identity" },
      now,
    );
    added += 1;
  }
  return added;
}
