// In-memory application state and its persistence. The background page is the only
// writer; nothing depends on this object surviving, it is rebuilt from storage.

import { buildPublicDomains } from "./address";
import { addEntry, entriesFromArray, removeEntry } from "./lists";
import type { AddResult, EntryMap, NewEntry } from "./lists";
import {
  EMPTY_LOG_META,
  KEY_ACCESS_POINTS,
  KEY_ENTRIES,
  KEY_LOG_META,
  KEY_META,
  KEY_SETTINGS,
  logChunkKey,
  PREFIX_PROCESSED_IN,
  PREFIX_PROCESSED_SENT,
} from "./keys";
import type { LogMeta } from "./keys";
import { appendLog, validateLogEntry, validateLogMeta } from "./log";
import type { KeyValueStore } from "./ports";
import { ProcessedSet } from "./processed";
import {
  asArray,
  asRecord,
  asString,
  defaultSettings,
  validateAccessPoints,
  validateEntries,
  validateSettings,
  ValidationError,
} from "./settings";
import type { AccessPoint, LogEntry, Settings } from "./types";

export {
  KEY_ACCESS_POINTS,
  KEY_ENTRIES,
  KEY_LOG_META,
  KEY_META,
  KEY_SETTINGS,
  PREFIX_LOG,
  PREFIX_PROCESSED_IN,
  PREFIX_PROCESSED_SENT,
} from "./keys";

export type ProcessedKind = "in" | "sent";

interface Meta {
  /** Time of the previous tick. Null before the first tick. */
  lastTick: number | null;
  /** Stable, opaque host id for ChatGPT plan sign-in (ext_agent_host_id). */
  hostId: string;
}

export class AppState {
  settings: Settings;
  entries: EntryMap;
  accessPoints: AccessPoint[];
  lastTick: number | null;
  hostId: string;
  /** Set when a white list entry was added. Cleared by the screening sweep. */
  whiteAdded = false;

  publicDomains: Set<string> = new Set();
  forwardingMailboxes: Set<string> = new Set();

  private readonly processed: Record<ProcessedKind, ProcessedSet>;
  private logMeta: LogMeta;
  private lastLogChunk: LogEntry[];
  private entriesSave: Promise<void> | null = null;

  private constructor(
    private readonly store: KeyValueStore,
    private readonly bundledPublicDomains: readonly string[],
    parts: {
      settings: Settings;
      entries: EntryMap;
      accessPoints: AccessPoint[];
      meta: Meta;
      processedIn: ProcessedSet;
      processedSent: ProcessedSet;
      logMeta: LogMeta;
      lastLogChunk: LogEntry[];
    },
  ) {
    this.settings = parts.settings;
    this.entries = parts.entries;
    this.accessPoints = parts.accessPoints;
    this.lastTick = parts.meta.lastTick;
    this.hostId = parts.meta.hostId;
    this.processed = { in: parts.processedIn, sent: parts.processedSent };
    this.logMeta = parts.logMeta;
    this.lastLogChunk = parts.lastLogChunk;
    this.refreshDerived();
  }

  /**
   * Builds the state from everything in storage. Missing keys get defaults, which
   * are stored. Data that fails validation throws a ValidationError and nothing is
   * written: nothing is repaired automatically.
   */
  static async load(
    raw: Record<string, unknown>,
    store: KeyValueStore,
    bundledPublicDomains: readonly string[],
    now: number,
  ): Promise<AppState> {
    const fresh: Record<string, unknown> = {};

    let settings: Settings;
    if (raw[KEY_SETTINGS] === undefined) {
      settings = defaultSettings(now);
      fresh[KEY_SETTINGS] = settings;
    } else {
      settings = validateSettings(raw[KEY_SETTINGS]);
    }

    const entries = entriesFromArray(raw[KEY_ENTRIES] === undefined ? [] : validateEntries(raw[KEY_ENTRIES]));
    const accessPoints = raw[KEY_ACCESS_POINTS] === undefined ? [] : validateAccessPoints(raw[KEY_ACCESS_POINTS]);

    let meta: Meta;
    if (raw[KEY_META] === undefined) {
      meta = { lastTick: null, hostId: `urn:uuid:${crypto.randomUUID()}` };
      fresh[KEY_META] = meta;
    } else {
      const record = asRecord(raw[KEY_META], KEY_META);
      const lastTick = record.lastTick;
      if (lastTick !== null && (typeof lastTick !== "number" || !Number.isFinite(lastTick))) {
        throw new ValidationError("meta.lastTick: expected a number or null");
      }
      meta = { lastTick, hostId: asString(record.hostId, "meta.hostId") };
    }

    const buckets: Record<ProcessedKind, Record<string, string[]>> = { in: {}, sent: {} };
    for (const [key, value] of Object.entries(raw)) {
      const kind = key.startsWith(PREFIX_PROCESSED_IN)
        ? "in"
        : key.startsWith(PREFIX_PROCESSED_SENT)
          ? "sent"
          : null;
      if (kind !== null) {
        const day = key.slice((kind === "in" ? PREFIX_PROCESSED_IN : PREFIX_PROCESSED_SENT).length);
        buckets[kind][day] = asArray(value, key, asString);
      }
    }

    // Every chunk the pages read is checked, not only the newest one that is appended to.
    const logMeta = raw[KEY_LOG_META] === undefined ? EMPTY_LOG_META : validateLogMeta(raw[KEY_LOG_META]);
    let lastLogChunk: LogEntry[] = [];
    for (let index = logMeta.first; index <= logMeta.last; index += 1) {
      const key = logChunkKey(index);
      if (raw[key] !== undefined) {
        const chunk = asArray(raw[key], key, validateLogEntry);
        if (index === logMeta.last) {
          lastLogChunk = chunk;
        }
      }
    }

    if (Object.keys(fresh).length > 0) {
      await store.set(fresh);
    }
    return new AppState(store, bundledPublicDomains, {
      settings,
      entries,
      accessPoints,
      meta,
      processedIn: new ProcessedSet(buckets.in),
      processedSent: new ProcessedSet(buckets.sent),
      logMeta,
      lastLogChunk,
    });
  }

  /** Recomputes the sets derived from settings. Call after settings change. */
  refreshDerived(): void {
    this.publicDomains = buildPublicDomains(
      this.bundledPublicDomains,
      this.settings.publicDomainsAdded,
      this.settings.publicDomainsRemoved,
    );
    this.forwardingMailboxes = new Set(this.settings.forwardingMailboxes);
  }

  /** Scope of entries created by learning, by AI and by shortcuts. */
  newEntryScope(accountId: string): string {
    return this.settings.newEntryScope === "shared" ? "all" : accountId;
  }

  async saveSettings(): Promise<void> {
    this.refreshDerived();
    await this.store.set({ [KEY_SETTINGS]: this.settings });
  }

  /** Adds an entry in memory. Call saveEntries to store it. */
  addEntry(entry: NewEntry, now: number): AddResult {
    const result = addEntry(this.entries, entry, now);
    if (entry.list === "white" && (result === "added" || result === "moved")) {
      this.whiteAdded = true;
    }
    return result;
  }

  removeEntry(key: string): boolean {
    return removeEntry(this.entries, key);
  }

  /** Stores both lists. Calls made in the same turn share one write. */
  saveEntries(): Promise<void> {
    if (this.entriesSave === null) {
      this.entriesSave = Promise.resolve().then(() => {
        this.entriesSave = null;
        return this.store.set({ [KEY_ENTRIES]: [...this.entries.values()] });
      });
    }
    return this.entriesSave;
  }

  async saveAccessPoints(): Promise<void> {
    await this.store.set({ [KEY_ACCESS_POINTS]: this.accessPoints });
  }

  async setLastTick(time: number): Promise<void> {
    this.lastTick = time;
    await this.store.set({ [KEY_META]: { lastTick: this.lastTick, hostId: this.hostId } satisfies Meta });
  }

  isProcessed(kind: ProcessedKind, id: string): boolean {
    return this.processed[kind].has(id);
  }

  /** Records a processed message in memory and adds the part that changed to the writes. */
  private recordProcessed(writes: Record<string, unknown>, kind: ProcessedKind, id: string, now: number, messageDate: number): void {
    const part = this.processed[kind].add(id, now, messageDate);
    if (part !== null) {
      writes[(kind === "in" ? PREFIX_PROCESSED_IN : PREFIX_PROCESSED_SENT) + part.key] = part.ids;
    }
  }

  async markProcessed(kind: ProcessedKind, id: string, now: number, messageDate: number): Promise<void> {
    await this.markProcessedMany(kind, [{ id, date: messageDate }], now);
  }

  /** Records several ids with one write. */
  async markProcessedMany(
    kind: ProcessedKind,
    items: readonly { id: string; date: number }[],
    now: number,
  ): Promise<void> {
    const writes: Record<string, unknown> = {};
    for (const item of items) {
      this.recordProcessed(writes, kind, item.id, now, item.date);
    }
    if (Object.keys(writes).length > 0) {
      await this.store.set(writes);
    }
  }

  async pruneProcessed(now: number): Promise<void> {
    const keys = [
      ...this.processed.in.prune(now).map((day) => PREFIX_PROCESSED_IN + day),
      ...this.processed.sent.prune(now).map((day) => PREFIX_PROCESSED_SENT + day),
    ];
    if (keys.length > 0) {
      await this.store.remove(keys);
    }
  }

  /**
   * Appends a log entry. When the entry is the decision about an incoming or sent
   * message, the message is recorded as processed in the same write.
   */
  async log(
    entry: LogEntry,
    processed?: { kind: ProcessedKind; id: string; now: number; messageDate: number },
  ): Promise<void> {
    const write = appendLog(this.logMeta, this.lastLogChunk, entry);
    this.logMeta = write.meta;
    this.lastLogChunk = write.chunk;
    const writes: Record<string, unknown> = { [logChunkKey(write.chunkIndex)]: write.chunk, [KEY_LOG_META]: write.meta };
    if (processed !== undefined) {
      this.recordProcessed(writes, processed.kind, processed.id, processed.now, processed.messageDate);
    }
    await this.store.set(writes);
    if (write.removeChunks.length > 0) {
      await this.store.remove(write.removeChunks.map(logChunkKey));
    }
  }

  async clearLog(): Promise<void> {
    const keys: string[] = [];
    for (let index = this.logMeta.first; index <= this.logMeta.last; index += 1) {
      keys.push(logChunkKey(index));
    }
    // Chunk numbers keep growing, so a page that still shows old chunks never mixes them with new ones.
    this.logMeta = { first: this.logMeta.last + 1, last: this.logMeta.last + 1 };
    this.lastLogChunk = [];
    await this.store.remove(keys);
    await this.store.set({ [KEY_LOG_META]: this.logMeta });
  }
}
