// Processed sets: which messages were already handled. The only pipeline state.
// Stored in per-day buckets and pruned after 30 days.

import type { MessageInfo } from "./types";

export const PROCESSED_KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC day of a timestamp, as YYYY-MM-DD. */
export function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * Identity of a message: the account id plus the Message-ID header. A message
 * without a Message-ID is identified by a hash of its date, author and subject.
 */
export async function processedId(message: MessageInfo): Promise<string> {
  if (message.headerMessageId !== "") {
    return `${message.accountId} ${message.headerMessageId}`;
  }
  const text = `${message.date}\n${message.author}\n${message.subject}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hex = Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${message.accountId} #${hex}`;
}

export class ProcessedSet {
  private readonly buckets = new Map<string, Set<string>>();

  constructor(buckets: Record<string, readonly string[]> = {}) {
    for (const [day, ids] of Object.entries(buckets)) {
      this.buckets.set(day, new Set(ids));
    }
  }

  has(id: string): boolean {
    for (const ids of this.buckets.values()) {
      if (ids.has(id)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Records an id and returns the bucket that changed. The bucket is the day of
   * processing, or the day of the message when it is dated in the future, so that
   * a record never expires while its message can still be returned by a query.
   */
  add(id: string, now: number, messageDate: number): { day: string; ids: string[] } {
    const day = dayKey(Math.max(now, messageDate));
    let ids = this.buckets.get(day);
    if (ids === undefined) {
      ids = new Set();
      this.buckets.set(day, ids);
    }
    ids.add(id);
    return { day, ids: [...ids] };
  }

  /** Drops buckets older than 30 days and returns their days. */
  prune(now: number): string[] {
    const oldest = dayKey(now - PROCESSED_KEEP_DAYS * DAY_MS);
    const removed: string[] = [];
    for (const day of this.buckets.keys()) {
      if (day < oldest) {
        this.buckets.delete(day);
        removed.push(day);
      }
    }
    return removed;
  }

  days(): string[] {
    return [...this.buckets.keys()].sort();
  }
}
