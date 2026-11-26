// In-memory fakes of the mail layer and storage for unit tests.

import { BUNDLED_PUBLIC_DOMAINS } from "../../src/data/publicDomains";
import type { KeyValueStore, MailPort, SpecialUse } from "../../src/core/ports";
import { folderKey } from "../../src/core/ports";
import { AppState } from "../../src/core/state";
import type { AccountInfo, FolderRef, Identity, MessageInfo } from "../../src/core/types";

export class MemoryStore implements KeyValueStore {
  data: Record<string, unknown> = {};
  writes = 0;

  async set(items: Record<string, unknown>): Promise<void> {
    this.writes += 1;
    Object.assign(this.data, structuredClone(items));
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) {
      delete this.data[key];
    }
  }
}

export interface FakeMessage extends MessageInfo {
  headers?: Record<string, string[]>;
  body?: string;
  attachedFrom?: string | null;
}

interface FakeFolder {
  ref: FolderRef;
  use: SpecialUse | null;
  messages: FakeMessage[];
}

let nextId = 1;

export function message(partial: Partial<FakeMessage> & { accountId: string }): FakeMessage {
  const id = nextId++;
  return {
    id,
    folder: null,
    headerMessageId: `msg-${id}@test`,
    author: "Sender <sender@unknown.example>",
    recipients: ["me@mycompany.example"],
    ccList: [],
    bccList: [],
    subject: `Subject ${id}`,
    date: Date.UTC(2026, 10, 21, 12),
    size: 1000,
    read: false,
    ...partial,
  };
}

/** Splits a header value into addresses the way a mailbox parser would, for simple inputs. */
export function fakeParseAddresses(raw: string): string[] {
  const result: string[] = [];
  for (const part of raw.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const angle = /<([^<>]+)>\s*$/.exec(part);
    const candidate = (angle?.[1] ?? part).trim();
    if (candidate.includes("@")) {
      result.push(candidate);
    }
  }
  return result;
}

export class FakeMail implements MailPort {
  accountList: AccountInfo[] = [];
  identityList: Identity[] = [];
  folders = new Map<string, FakeFolder>();
  moves: { ids: number[]; to: FolderRef }[] = [];
  /** Every change of the read state, in order. */
  readChanges: { ids: number[]; read: boolean }[] = [];
  failMoves = false;
  /** Set for a server that refuses to mark messages read or unread. */
  failSetRead = false;
  failBody = false;
  pageSize = 2;
  bodyReads = 0;
  headerReads = 0;
  parseCalls = 0;

  addAccount(id: string, email: string | null, name = id): this {
    this.accountList.push({ id, name, email });
    if (email !== null) {
      this.identityList.push({ accountId: id, email });
    }
    this.addFolder({ accountId: id, path: "/INBOX" }, "inbox");
    this.addFolder({ accountId: id, path: "/Sent" }, "sent");
    this.addFolder({ accountId: id, path: "/Junk" }, "junk");
    return this;
  }

  addFolder(ref: FolderRef, use: SpecialUse | null = null): FolderRef {
    this.folders.set(folderKey(ref), { ref, use, messages: [] });
    return ref;
  }

  removeFolder(ref: FolderRef): void {
    this.folders.delete(folderKey(ref));
  }

  put(ref: FolderRef, partial: Partial<FakeMessage> = {}): FakeMessage {
    const folder = this.folder(ref);
    const created = message({ accountId: ref.accountId, ...partial, folder: ref });
    folder.messages.push(created);
    return created;
  }

  folder(ref: FolderRef): FakeFolder {
    const folder = this.folders.get(folderKey(ref));
    if (folder === undefined) {
      throw new Error(`no folder ${folderKey(ref)}`);
    }
    return folder;
  }

  ids(ref: FolderRef): number[] {
    return this.folder(ref).messages.map((item) => item.id);
  }

  private find(id: number): FakeMessage {
    for (const folder of this.folders.values()) {
      const found = folder.messages.find((item) => item.id === id);
      if (found !== undefined) {
        return found;
      }
    }
    throw new Error(`no message ${id}`);
  }

  async accounts(): Promise<AccountInfo[]> {
    return this.accountList;
  }

  async identities(): Promise<Identity[]> {
    return this.identityList;
  }

  async specialFolders(use: SpecialUse): Promise<FolderRef[]> {
    return [...this.folders.values()].filter((folder) => folder.use === use).map((folder) => folder.ref);
  }

  private async *pages(items: FakeMessage[]): AsyncIterable<MessageInfo[]> {
    for (let start = 0; start < items.length; start += this.pageSize) {
      yield items.slice(start, start + this.pageSize);
    }
  }

  messagesSince(folder: FolderRef, since: number, until?: number): AsyncIterable<MessageInfo[]> {
    // Both bounds are inclusive, like fromDate and toDate of Thunderbird's messages.query.
    const items = this.folder(folder).messages.filter(
      (item) => item.date >= since && (until === undefined || item.date <= until),
    );
    return this.pages(items);
  }

  allMessages(folder: FolderRef): AsyncIterable<MessageInfo[]> {
    return this.pages([...this.folder(folder).messages]);
  }

  /** Set to false for a server that does not say how many messages a folder holds. */
  countsKnown = true;

  async messageCount(folder: FolderRef): Promise<number | null> {
    return this.countsKnown ? this.folder(folder).messages.length : null;
  }

  async parseAddresses(raw: string): Promise<string[]> {
    this.parseCalls += 1;
    return fakeParseAddresses(raw);
  }

  async headers(messageId: number): Promise<Record<string, string[]>> {
    this.headerReads += 1;
    return this.find(messageId).headers ?? {};
  }

  async attachedMessageFrom(messageId: number): Promise<string | null> {
    return this.find(messageId).attachedFrom ?? null;
  }

  async bodyText(messageId: number): Promise<string> {
    this.bodyReads += 1;
    if (this.failBody) {
      throw new Error("body unavailable");
    }
    return this.find(messageId).body ?? "Hello";
  }

  async findByMessageId(accountId: string, headerMessageId: string): Promise<MessageInfo[]> {
    const found: MessageInfo[] = [];
    for (const folder of this.folders.values()) {
      found.push(...folder.messages.filter((item) => item.accountId === accountId && item.headerMessageId === headerMessageId));
    }
    return found;
  }

  async move(messageIds: number[], target: FolderRef): Promise<void> {
    if (this.failMoves) {
      throw new Error("move refused");
    }
    const destination = this.folder(target);
    for (const id of messageIds) {
      for (const folder of this.folders.values()) {
        const index = folder.messages.findIndex((item) => item.id === id);
        if (index !== -1) {
          const [moved] = folder.messages.splice(index, 1);
          if (moved !== undefined) {
            moved.folder = target;
            destination.messages.push(moved);
          }
        }
      }
    }
    this.moves.push({ ids: [...messageIds], to: target });
  }

  async setRead(messageIds: number[], read: boolean): Promise<number[]> {
    if (this.failSetRead) {
      throw new Error("update refused");
    }
    for (const id of messageIds) {
      this.find(id).read = read;
    }
    this.readChanges.push({ ids: [...messageIds], read });
    return [...messageIds];
  }
}

export const NOW = Date.UTC(2026, 10, 21, 13);

export async function makeState(
  raw: Record<string, unknown> = {},
  now = NOW,
): Promise<{ state: AppState; store: MemoryStore }> {
  const store = new MemoryStore();
  store.data = structuredClone(raw);
  const state = await AppState.load(structuredClone(raw), store, BUNDLED_PUBLIC_DOMAINS, now);
  return { state, store };
}

/** Reloads the state from what was stored, as a restarted background page would. */
export async function reload(store: MemoryStore, now = NOW): Promise<AppState> {
  return AppState.load(structuredClone(store.data), store, BUNDLED_PUBLIC_DOMAINS, now);
}
