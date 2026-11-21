// A fake of the Thunderbird WebExtension API, enough to load the background page in a
// test and drive it through the requests of the settings page and the popup.

import { vi } from "vitest";
import type { FetchLike } from "../../src/ai/http";
import type { Reply, RequestName, Requests } from "../../src/tb/protocol";
import { fakeParseAddresses } from "./fakes";

type Listener = (...args: never[]) => unknown;

export class FakeEvent<L extends Listener = Listener> {
  readonly listeners: L[] = [];

  addListener(listener: L): void {
    this.listeners.push(listener);
  }

  removeListener(listener: L): void {
    const index = this.listeners.indexOf(listener);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  }

  hasListener(listener: L): boolean {
    return this.listeners.includes(listener);
  }
}

const ACCOUNT_ID = "account1";
const FOLDERS: tb.MailFolder[] = [
  { id: "f-root", accountId: ACCOUNT_ID, name: "Root", path: "/", specialUse: [], isRoot: true, isVirtual: false, isUnified: false, isTag: false },
  { id: "f-inbox", accountId: ACCOUNT_ID, name: "Inbox", path: "/INBOX", specialUse: ["inbox"], isRoot: false, isVirtual: false, isUnified: false, isTag: false },
  { id: "f-sent", accountId: ACCOUNT_ID, name: "Sent", path: "/Sent", specialUse: ["sent"], isRoot: false, isVirtual: false, isUnified: false, isTag: false },
  { id: "f-junk", accountId: ACCOUNT_ID, name: "Junk", path: "/Junk", specialUse: ["junk"], isRoot: false, isVirtual: false, isUnified: false, isTag: false },
];
const IDENTITY: tb.MailIdentity = { id: "identity1", accountId: ACCOUNT_ID, email: "me@mycompany.example", name: "Me" };
const PAGE_SIZE = 100;

/** One account (account1, me@mycompany.example) with an Inbox, Sent and Junk folder, and in-memory storage. */
export class FakeBrowser {
  storage: Record<string, unknown>;
  /** Granted host permission patterns. */
  readonly granted = new Set<string>();
  /** Messages selected in the mail tab with id 1. */
  selected: tb.MessageHeader[] = [];
  readonly openedTabs: string[] = [];
  readonly closedTabs: number[] = [];
  readonly notifications: string[] = [];
  readonly api: tb.Browser;

  private readonly lists = new Map<string, tb.MessageHeader[]>();
  private nextList = 1;
  private nextTab = 100;

  constructor(storage: Record<string, unknown> = {}) {
    this.storage = structuredClone(storage);
    const page = (messages: tb.MessageHeader[]): tb.MessageList => {
      if (messages.length <= PAGE_SIZE) {
        return { id: null, messages };
      }
      const id = `list-${this.nextList++}`;
      this.lists.set(id, messages.slice(PAGE_SIZE));
      return { id, messages: messages.slice(0, PAGE_SIZE) };
    };
    const empty: tb.MessageList = { id: null, messages: [] };
    const api = {
      accounts: {
        list: async () => [{ id: ACCOUNT_ID, name: "Work", type: "imap", identities: [IDENTITY], rootFolder: FOLDERS[0] }],
        get: async (id: string) => (id === ACCOUNT_ID ? { id, name: "Work", type: "imap", identities: [IDENTITY], rootFolder: FOLDERS[0] } : null),
      },
      identities: {
        list: async () => [IDENTITY],
        get: async (id: string) => (id === IDENTITY.id ? IDENTITY : null),
      },
      folders: {
        query: async (query: { accountId?: string; specialUse?: string[] } = {}) =>
          FOLDERS.filter(
            (folder) =>
              (query.accountId === undefined || folder.accountId === query.accountId) &&
              (query.specialUse === undefined || query.specialUse.every((use) => folder.specialUse.includes(use))),
          ),
      },
      messages: {
        query: async () => empty,
        list: async () => empty,
        continueList: async (id: string) => {
          const rest = this.lists.get(id) ?? [];
          this.lists.delete(id);
          return page(rest);
        },
        abortList: async (id: string) => {
          this.lists.delete(id);
        },
        getHeaders: async () => ({}),
        listAttachments: async () => [],
        listInlineTextParts: async () => [{ contentType: "text/plain", content: "Hello" }],
        move: async () => undefined,
        onNewMailReceived: new FakeEvent(),
      },
      messengerUtilities: {
        parseMailboxString: async (text: string) => fakeParseAddresses(text).map((email) => ({ email })),
        convertToPlainText: async (text: string) => text,
      },
      mailTabs: {
        getSelectedMessages: async () => page([...this.selected]),
      },
      messageDisplay: {
        getDisplayedMessages: async () => empty,
      },
      compose: { onAfterSend: new FakeEvent() },
      commands: {
        getAll: async () => [],
        openShortcutSettings: async () => undefined,
        onCommand: new FakeEvent(),
        onChanged: new FakeEvent(),
      },
      tabs: {
        create: async (properties: { url: string }) => {
          this.openedTabs.push(properties.url);
          return { id: this.nextTab++, active: true, type: "content" };
        },
        query: async () => [{ id: 1, type: "mail", active: true, windowId: 1 }],
        get: async (id: number) => ({ id, type: "mail", active: true, windowId: 1 }),
        remove: async (id: number | number[]) => {
          this.closedTabs.push(...(Array.isArray(id) ? id : [id]));
        },
      },
      windows: { openDefaultBrowser: async () => undefined },
      alarms: { create: () => undefined, get: async () => undefined, onAlarm: new FakeEvent() },
      notifications: {
        create: async (options: { message: string }) => {
          this.notifications.push(options.message);
          return "notification";
        },
      },
      permissions: {
        request: async (set: tb.PermissionSet) => {
          for (const origin of set.origins ?? []) {
            this.granted.add(origin);
          }
          return true;
        },
        contains: async (set: tb.PermissionSet) => (set.origins ?? []).every((origin) => this.granted.has(origin)),
        getAll: async () => ({ origins: [...this.granted], permissions: [] }),
        onAdded: new FakeEvent(),
      },
      webRequest: undefined,
      storage: {
        local: {
          get: async (keys?: string | string[] | null) => {
            if (keys === null || keys === undefined) {
              return structuredClone(this.storage);
            }
            const wanted = Array.isArray(keys) ? keys : [keys];
            return structuredClone(Object.fromEntries(wanted.filter((key) => key in this.storage).map((key) => [key, this.storage[key]])));
          },
          set: async (items: Record<string, unknown>) => {
            Object.assign(this.storage, structuredClone(items));
          },
          remove: async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              delete this.storage[key];
            }
          },
          clear: async () => {
            this.storage = {};
          },
        },
        onChanged: new FakeEvent(),
      },
      runtime: {
        id: "block-spam@thunderbird-block-spam",
        getURL: (path: string) => `moz-extension://test/${path}`,
        getManifest: () => ({ version: "1.0.0", name: "Block Spam", optional_permissions: ["accountsFolders", "webRequest"] }),
        getPlatformInfo: async () => ({ os: "linux" }),
        openOptionsPage: async () => undefined,
        sendMessage: async () => undefined,
        onMessage: new FakeEvent(),
        onMessageExternal: new FakeEvent(),
        onInstalled: new FakeEvent(),
        onStartup: new FakeEvent(),
      },
      i18n: {
        getMessage: (name: string, substitutions: string[] = []) =>
          substitutions.length === 0 ? name : `${name}(${substitutions.join(", ")})`,
      },
    };
    this.api = api as unknown as tb.Browser;
  }

  /** A message header in the Inbox of account1. */
  static header(id: number, author: string): tb.MessageHeader {
    return {
      id,
      author,
      recipients: ["me@mycompany.example"],
      ccList: [],
      bccList: [],
      subject: `Subject ${id}`,
      date: new Date(Date.UTC(2026, 10, 21, 12)),
      headerMessageId: `msg-${id}@test`,
      size: 1000,
      external: false,
      folder: FOLDERS[1],
    };
  }
}

export interface Background {
  /** Sends a request as the settings page or the popup does. */
  send<Name extends RequestName>(name: Name, args: Requests[Name]["request"]): Promise<Reply<Requests[Name]["result"]>>;
  /** Fires a browser event the background listens to. */
  fire(event: FakeEvent, ...args: unknown[]): unknown;
}

/** Loads a fresh copy of the background page against the fake. */
export async function loadBackground(fake: FakeBrowser, fetch: FetchLike): Promise<Background> {
  vi.resetModules();
  vi.stubGlobal("browser", fake.api);
  vi.stubGlobal("fetch", fetch);
  await import("../../src/background");
  const onMessage = fake.api.runtime.onMessage as unknown as FakeEvent<(message: unknown, sender: tb.MessageSender) => Promise<unknown>>;
  return {
    async send(name, args) {
      const listener = onMessage.listeners[0];
      if (listener === undefined) {
        throw new Error("the background registered no message listener");
      }
      return (await listener({ blockSpam: name, args }, { id: fake.api.runtime.id })) as never;
    },
    fire(event, ...args) {
      let result: unknown;
      for (const listener of event.listeners) {
        result = (listener as (...values: unknown[]) => unknown)(...args);
      }
      return result;
    },
  };
}
