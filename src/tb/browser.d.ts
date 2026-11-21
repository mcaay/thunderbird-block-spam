// Type declarations for the part of the Thunderbird WebExtension API (Manifest V3,
// Thunderbird 153) that Block Spam uses. Written from the API documentation at
// https://webextension-api.thunderbird.net/en/mv3/.

declare namespace tb {
  interface WebExtEvent<Listener extends (...args: never[]) => unknown> {
    addListener(listener: Listener, ...extra: unknown[]): void;
    removeListener(listener: Listener): void;
    hasListener(listener: Listener): boolean;
  }

  interface MailFolder {
    id: string;
    accountId?: string;
    name: string;
    path: string;
    specialUse: string[];
    isRoot: boolean;
    isVirtual: boolean;
    isUnified: boolean;
    isTag: boolean;
    subFolders?: MailFolder[];
  }

  interface MailIdentity {
    id?: string;
    accountId?: string;
    email?: string;
    name?: string;
  }

  interface MailAccount {
    id: string;
    name: string;
    type: string;
    identities: MailIdentity[];
    rootFolder: MailFolder;
  }

  interface MessageHeader {
    id: number;
    author: string;
    recipients: string[];
    ccList: string[];
    bccList: string[];
    subject: string;
    date: Date;
    headerMessageId: string;
    size: number;
    external: boolean;
    folder?: MailFolder;
  }

  interface MessageList {
    id: string | null;
    messages: MessageHeader[];
  }

  interface InlineTextPart {
    contentType: string;
    content: string;
  }

  interface MessageAttachment {
    contentType: string;
    name: string;
    partName: string;
    size: number;
    message?: MessageHeader;
  }

  interface ParsedMailbox {
    email?: string;
    name?: string;
    group?: ParsedMailbox[];
  }

  interface Tab {
    id?: number;
    windowId?: number;
    type?: string;
    active: boolean;
    /** Only set for tabs the add-on may see the address of: its own pages. */
    url?: string;
  }

  type ComposeRecipient = string | { nodeId: string; type: string };

  interface ComposeDetails {
    identityId?: string;
    to?: ComposeRecipient | ComposeRecipient[];
    cc?: ComposeRecipient | ComposeRecipient[];
    bcc?: ComposeRecipient | ComposeRecipient[];
  }

  interface SendInfo {
    mode: string;
    error?: string;
    headerMessageId?: string;
    details?: ComposeDetails;
    messages?: MessageHeader[];
  }

  interface MessageSender {
    id?: string;
    tab?: Tab;
    url?: string;
  }

  interface PermissionSet {
    permissions?: string[];
    origins?: string[];
    data_collection?: string[];
  }

  interface Command {
    name?: string;
    description?: string;
    shortcut?: string;
  }

  interface StorageChange {
    oldValue?: unknown;
    newValue?: unknown;
  }

  interface Browser {
    accounts: {
      list(includeSubFolders?: boolean): Promise<MailAccount[]>;
      get(accountId: string, includeSubFolders?: boolean): Promise<MailAccount | null>;
    };
    identities: {
      list(accountId?: string): Promise<MailIdentity[]>;
      get(identityId: string): Promise<MailIdentity | null>;
    };
    folders: {
      query(queryInfo?: { accountId?: string; specialUse?: string[] }): Promise<MailFolder[]>;
      getFolderInfo(folderId: string): Promise<{ totalMessageCount?: number; unreadMessageCount?: number }>;
      /** Needs the optional accountsFolders permission. */
      create?(folderId: string, childName: string): Promise<MailFolder>;
    };
    messages: {
      query(queryInfo: {
        accountId?: string;
        folderId?: string;
        headerMessageId?: string;
        fromDate?: Date;
        toDate?: Date;
        messagesPerPage?: number;
      }): Promise<MessageList>;
      list(folderId: string): Promise<MessageList>;
      continueList(messageListId: string): Promise<MessageList>;
      abortList(messageListId: string): Promise<void>;
      getHeaders(messageId: number): Promise<Record<string, string[]>>;
      listAttachments(messageId: number): Promise<MessageAttachment[]>;
      listInlineTextParts(messageId: number): Promise<InlineTextPart[]>;
      move(messageIds: number[], folderId: string): Promise<void>;
      onNewMailReceived: WebExtEvent<(folder: MailFolder, messages: MessageList) => void>;
    };
    messengerUtilities: {
      parseMailboxString(mailboxString: string): Promise<ParsedMailbox[]>;
      convertToPlainText(body: string): Promise<string>;
    };
    mailTabs: {
      getSelectedMessages(tabId?: number): Promise<MessageList>;
    };
    messageDisplay: {
      getDisplayedMessages(tabId?: number): Promise<MessageList>;
      /** Opens a message in a new tab or window. */
      open(properties: { messageId: number; location?: "tab" | "window"; active?: boolean }): Promise<Tab>;
    };
    /** The toolbar button. */
    action: {
      setBadgeText(details: { text: string | null }): Promise<void>;
      setBadgeBackgroundColor(details: { color: string | null }): Promise<void>;
      setBadgeTextColor(details: { color: string | null }): Promise<void>;
      setTitle(details: { title: string | null }): Promise<void>;
    };
    compose: {
      onAfterSend: WebExtEvent<(tab: Tab, sendInfo: SendInfo) => void>;
    };
    commands: {
      getAll(): Promise<Command[]>;
      /** Added in Thunderbird 137. */
      openShortcutSettings(): Promise<void>;
      onCommand: WebExtEvent<(command: string, tab: Tab) => void>;
      onChanged: WebExtEvent<(changeInfo: { name: string }) => void>;
    };
    tabs: {
      create(properties: { url: string; windowId?: number; active?: boolean; linkHandler?: string }): Promise<Tab>;
      query(queryInfo: { active?: boolean; currentWindow?: boolean; lastFocusedWindow?: boolean; url?: string }): Promise<Tab[]>;
      get(tabId: number): Promise<Tab>;
      update(tabId: number, properties: { active?: boolean }): Promise<Tab>;
      remove(tabIds: number | number[]): Promise<void>;
    };
    windows: {
      openDefaultBrowser(url: string): Promise<void>;
      update(windowId: number, properties: { focused?: boolean }): Promise<unknown>;
    };
    alarms: {
      create(name: string, alarmInfo: { periodInMinutes?: number; delayInMinutes?: number }): void | Promise<void>;
      get(name: string): Promise<{ name: string } | undefined>;
      onAlarm: WebExtEvent<(alarm: { name: string }) => void>;
    };
    menus: {
      create(
        properties: {
          id?: string;
          parentId?: string;
          title?: string;
          type?: "normal" | "separator";
          contexts?: string[];
        },
        callback?: () => void,
      ): string | number;
      removeAll(): Promise<void>;
      onClicked: WebExtEvent<(info: { menuItemId: string | number; selectedMessages?: MessageList }, tab?: Tab) => void>;
    };
    notifications: {
      create(options: { type: "basic"; title: string; message: string; iconUrl?: string }): Promise<string>;
      create(id: string, options: { type: "basic"; title: string; message: string; iconUrl?: string }): Promise<string>;
      onClicked: WebExtEvent<(notificationId: string) => void>;
    };
    permissions: {
      request(permissions: PermissionSet): Promise<boolean>;
      contains(permissions: PermissionSet): Promise<boolean>;
      getAll(): Promise<PermissionSet>;
      onAdded: WebExtEvent<(permissions: PermissionSet) => void>;
      onRemoved: WebExtEvent<(permissions: PermissionSet) => void>;
    };
    /** Present only after the optional webRequest permission was granted. */
    webRequest?: {
      onBeforeRequest: WebExtEvent<(details: { url: string; tabId: number }) => void>;
    };
    storage: {
      local: {
        get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
        set(items: Record<string, unknown>): Promise<void>;
        remove(keys: string | string[]): Promise<void>;
        clear(): Promise<void>;
      };
      onChanged: WebExtEvent<(changes: Record<string, StorageChange>, areaName: string) => void>;
    };
    runtime: {
      id: string;
      /** Set while the callback of a failed call runs. Reading it marks the error as handled. */
      lastError?: { message?: string } | null;
      getURL(path: string): string;
      getManifest(): { version: string; name: string; optional_permissions?: string[] };
      getPlatformInfo(): Promise<{ os: string }>;
      openOptionsPage(): Promise<void>;
      sendMessage(message: unknown): Promise<unknown>;
      onMessage: WebExtEvent<(message: unknown, sender: MessageSender) => Promise<unknown> | undefined>;
      onMessageExternal: WebExtEvent<(message: unknown, sender: MessageSender) => Promise<unknown> | undefined>;
      onInstalled: WebExtEvent<(details: { reason: string }) => void>;
      onStartup: WebExtEvent<() => void>;
    };
    i18n: {
      getMessage(name: string, substitutions?: string | string[]): string;
      getUILanguage(): string;
    };
  }
}

declare const browser: tb.Browser;
