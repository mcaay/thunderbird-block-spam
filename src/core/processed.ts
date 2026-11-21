// Processed sets: which messages were already handled. The only pipeline state.
// Stored in per-day buckets and pruned after 30 days.

import type { MessageInfo } from "./types";

export const PROCESSED_KEEP_DAYS = 30;
/**
 * Ids per stored part of a day. A new id is written with the part that holds it, so
 * the work of one message does not grow with the number of messages that day.
 */
export const PROCESSED_PART_SIZE = 100;
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

/** The storage key suffix of a part: the day for the first part, "day:n" for the others. */
export function partKey(day: string, index: number): string {
  return index === 0 ? day : `${day}:${index}`;
}

function parsePartKey(key: string): { day: string; index: number } {
  const match = /^(.*):(\d+)$/.exec(key);
  return match === null ? { day: key, index: 0 } : { day: match[1] as string, index: Number(match[2]) };
}

interface Day {
  ids: Set<string>;
  /** Stored parts in order. Only the last one takes new ids. */
  parts: { index: number; ids: string[] }[];
}

export class ProcessedSet {
  private readonly byDay = new Map<string, Day>();

  /** Takes the stored parts, keyed by their storage key suffix (see partKey). */
  constructor(parts: Record<string, readonly string[]> = {}) {
    for (const [key, ids] of Object.entries(parts)) {
      const { day, index } = parsePartKey(key);
      const entry = this.day(day);
      entry.parts.push({ index, ids: [...ids] });
      for (const id of ids) {
        entry.ids.add(id);
      }
    }
    for (const entry of this.byDay.values()) {
      entry.parts.sort((a, b) => a.index - b.index);
    }
  }

  private day(day: string): Day {
    let entry = this.byDay.get(day);
    if (entry === undefined) {
      entry = { ids: new Set(), parts: [] };
      this.byDay.set(day, entry);
    }
    return entry;
  }

  has(id: string): boolean {
    for (const entry of this.byDay.values()) {
      if (entry.ids.has(id)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Records an id and returns the part to store: its key suffix and its ids. Null
   * when the id was already recorded on that day. The day is the day of processing,
   * or the day of the message when it is dated in the future, so that a record never
   * expires while its message can still be returned by a query.
   */
  add(id: string, now: number, messageDate: number): { key: string; ids: string[] } | null {
    const day = dayKey(Math.max(now, messageDate));
    const entry = this.day(day);
    if (entry.ids.has(id)) {
      return null;
    }
    entry.ids.add(id);
    let part = entry.parts.at(-1);
    if (part === undefined || part.ids.length >= PROCESSED_PART_SIZE) {
      part = { index: part === undefined ? 0 : part.index + 1, ids: [] };
      entry.parts.push(part);
    }
    part.ids.push(id);
    return { key: partKey(day, part.index), ids: part.ids };
  }

  /** Drops days older than 30 days and returns the key suffixes of their parts. */
  prune(now: number): string[] {
    const oldest = dayKey(now - PROCESSED_KEEP_DAYS * DAY_MS);
    const removed: string[] = [];
    for (const [day, entry] of this.byDay) {
      if (day < oldest) {
        this.byDay.delete(day);
        removed.push(...entry.parts.map((part) => partKey(day, part.index)));
      }
    }
    return removed;
  }

  days(): string[] {
    return [...this.byDay.keys()].sort();
  }
}
