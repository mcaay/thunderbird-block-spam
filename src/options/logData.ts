// Reads the decision log from storage for the settings page and the popup. The pages
// only read storage; the background is the only writer.

import { EMPTY_LOG_META, KEY_LOG_META, logChunkKey } from "../core/keys";
import type { LogMeta } from "../core/keys";
import type { LogEntry } from "../core/types";

/** Entries logged before the Message-ID was recorded are stored without one. */
function complete(chunk: unknown): LogEntry[] {
  return Array.isArray(chunk) ? (chunk as LogEntry[]).map((entry) => (entry.messageId === undefined ? { ...entry, messageId: "" } : entry)) : [];
}

async function readMeta(): Promise<LogMeta> {
  return ((await browser.storage.local.get(KEY_LOG_META))[KEY_LOG_META] as LogMeta | undefined) ?? EMPTY_LOG_META;
}

/** The newest entries, newest first. Reads no more chunks than it needs. */
export async function recentLog(limit: number): Promise<LogEntry[]> {
  const meta = await readMeta();
  const entries: LogEntry[] = [];
  for (let index = meta.last; index >= meta.first && entries.length < limit; index -= 1) {
    const key = logChunkKey(index);
    entries.push(...complete((await browser.storage.local.get(key))[key]).reverse());
  }
  return entries.slice(0, limit);
}

/** The whole log, read again only when it changed. Full chunks never change, so they are read once. */
export class LogReader {
  private readonly fullChunks = new Map<number, LogEntry[]>();
  private signature = "";
  private entries: LogEntry[] = [];

  /** All entries, newest first, and whether they differ from what the last call returned. */
  async load(): Promise<{ entries: LogEntry[]; changed: boolean }> {
    const meta = await readMeta();
    const lastKey = logChunkKey(meta.last);
    const last = complete((await browser.storage.local.get(lastKey))[lastKey]);
    const signature = `${meta.first}:${meta.last}:${last.length}`;
    if (signature === this.signature) {
      return { entries: this.entries, changed: false };
    }
    for (const index of [...this.fullChunks.keys()]) {
      if (index < meta.first || index >= meta.last) {
        this.fullChunks.delete(index);
      }
    }
    const missing: string[] = [];
    for (let index = meta.first; index < meta.last; index += 1) {
      if (!this.fullChunks.has(index)) {
        missing.push(logChunkKey(index));
      }
    }
    const chunks = missing.length === 0 ? {} : await browser.storage.local.get(missing);
    const loaded: LogEntry[] = [];
    for (let index = meta.first; index < meta.last; index += 1) {
      const chunk = this.fullChunks.get(index) ?? complete(chunks[logChunkKey(index)]);
      this.fullChunks.set(index, chunk);
      loaded.push(...chunk);
    }
    loaded.push(...last);
    this.signature = signature;
    this.entries = loaded.reverse();
    return { entries: this.entries, changed: true };
  }
}

/** One reader for the page: the Overview and the Log pane show the same entries. */
export const logReader = new LogReader();
