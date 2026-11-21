// The mail layer: thin wrappers over the Thunderbird messages, folders, accounts and
// identities APIs.

import { normalizeAddress } from "../core/address";
import type { MailPort, SpecialUse } from "../core/ports";
import { folderKey } from "../core/ports";
import type { AccountInfo, FolderRef, Identity, MessageInfo } from "../core/types";

const PAGE_SIZE = 100;
const HEADER_TIMEOUT_MS = 30 * 1000;

/** Converts a message header. Returns null for messages that are not in a folder (opened from a file). */
export function toMessageInfo(header: tb.MessageHeader): MessageInfo | null {
  const folder = header.folder;
  if (header.external || folder === undefined || folder.accountId === undefined) {
    return null;
  }
  const date = header.date instanceof Date ? header.date.getTime() : new Date(header.date).getTime();
  return {
    id: header.id,
    accountId: folder.accountId,
    folder: { accountId: folder.accountId, path: folder.path },
    headerMessageId: header.headerMessageId ?? "",
    author: header.author ?? "",
    recipients: header.recipients ?? [],
    ccList: header.ccList ?? [],
    bccList: header.bccList ?? [],
    subject: header.subject ?? "",
    date: Number.isFinite(date) ? date : 0,
    size: header.size ?? 0,
  };
}

function toFolderRef(folder: tb.MailFolder): FolderRef | null {
  if (folder.accountId === undefined || folder.isVirtual || folder.isUnified || folder.isTag) {
    return null;
  }
  return { accountId: folder.accountId, path: folder.path };
}

function emailsOf(mailboxes: tb.ParsedMailbox[]): string[] {
  const emails: string[] = [];
  for (const mailbox of mailboxes) {
    if (mailbox.group !== undefined) {
      emails.push(...emailsOf(mailbox.group));
    } else if (typeof mailbox.email === "string" && mailbox.email !== "") {
      emails.push(mailbox.email);
    }
  }
  return emails;
}

/** Pages of a message list. Stops the list on the server when the consumer stops early. */
export async function* messagePages(first: tb.MessageList): AsyncIterable<MessageInfo[]> {
  let page = first;
  try {
    for (;;) {
      yield page.messages.map(toMessageInfo).filter((info): info is MessageInfo => info !== null);
      if (page.id === null || page.id === undefined) {
        break;
      }
      page = await browser.messages.continueList(page.id);
    }
  } finally {
    if (page.id !== null && page.id !== undefined) {
      await browser.messages.abortList(page.id).catch(() => undefined);
    }
  }
}

export class ThunderbirdMail implements MailPort {
  /** Folder ids per account. Folder ids are only valid within a session, so they are never stored. */
  private folderIds = new Map<string, Promise<Map<string, string>>>();

  /** Forgets cached folder ids. Called when a job starts. */
  resetCache(): void {
    this.folderIds.clear();
  }

  async accounts(): Promise<AccountInfo[]> {
    const accounts = await browser.accounts.list(false);
    return accounts.map((account) => ({
      id: account.id,
      name: account.name,
      email: normalizeAddress(account.identities[0]?.email ?? ""),
    }));
  }

  async identities(): Promise<Identity[]> {
    const identities = await browser.identities.list();
    return identities
      .filter(
        (identity): identity is tb.MailIdentity & { accountId: string; email: string } =>
          typeof identity.accountId === "string" && typeof identity.email === "string" && identity.email !== "",
      )
      .map((identity) => ({ accountId: identity.accountId, email: identity.email }));
  }

  async specialFolders(use: SpecialUse): Promise<FolderRef[]> {
    const folders = await browser.folders.query({ specialUse: [use] });
    return folders.map(toFolderRef).filter((folder): folder is FolderRef => folder !== null);
  }

  private async folderId(folder: FolderRef): Promise<string> {
    let ids = this.folderIds.get(folder.accountId);
    if (ids === undefined) {
      ids = browser.folders
        .query({ accountId: folder.accountId })
        .then((folders) => new Map(folders.map((item) => [item.path, item.id])));
      this.folderIds.set(folder.accountId, ids);
    }
    const id = (await ids).get(folder.path);
    if (id === undefined) {
      this.folderIds.delete(folder.accountId);
      throw new Error(`folder not found: ${folderKey(folder)}`);
    }
    return id;
  }

  async *messagesSince(folder: FolderRef, since: number, until?: number): AsyncIterable<MessageInfo[]> {
    const query: { folderId: string; fromDate: Date; toDate?: Date; messagesPerPage: number } = {
      folderId: await this.folderId(folder),
      fromDate: new Date(since),
      messagesPerPage: PAGE_SIZE,
    };
    if (until !== undefined) {
      query.toDate = new Date(until);
    }
    yield* messagePages(await browser.messages.query(query));
  }

  async *allMessages(folder: FolderRef): AsyncIterable<MessageInfo[]> {
    yield* messagePages(await browser.messages.list(await this.folderId(folder)));
  }

  async messageCount(folder: FolderRef): Promise<number | null> {
    const count = (await browser.folders.getFolderInfo(await this.folderId(folder))).totalMessageCount;
    return typeof count === "number" && Number.isFinite(count) && count >= 0 ? count : null;
  }

  async parseAddresses(raw: string): Promise<string[]> {
    return emailsOf(await browser.messengerUtilities.parseMailboxString(raw));
  }

  async headers(messageId: number): Promise<Record<string, string[]>> {
    // A chunked IMAP fetch can leave getHeaders pending indefinitely. Let the
    // existing missing-header fallback run instead of blocking the whole queue.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        browser.messages.getHeaders(messageId),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Timed out reading message headers")), HEADER_TIMEOUT_MS);
        }),
      ]);
      const headers: Record<string, string[]> = {};
      for (const [name, values] of Object.entries(raw)) {
        headers[name.toLowerCase()] = Array.isArray(values) ? values.map(String) : [String(values)];
      }
      return headers;
    } finally {
      clearTimeout(timer);
    }
  }

  async attachedMessageFrom(messageId: number): Promise<string | null> {
    const attachments = await browser.messages.listAttachments(messageId);
    const attached = attachments.find(
      (attachment) => attachment.message !== undefined && attachment.contentType.toLowerCase().startsWith("message/rfc822"),
    );
    return attached?.message?.author ?? null;
  }

  async bodyText(messageId: number): Promise<string> {
    const parts = await browser.messages.listInlineTextParts(messageId);
    const plain = parts.find((part) => part.contentType.toLowerCase().startsWith("text/plain") && part.content.trim() !== "");
    if (plain !== undefined) {
      return plain.content;
    }
    const html = parts.find((part) => part.contentType.toLowerCase().startsWith("text/html") && part.content.trim() !== "");
    if (html !== undefined) {
      return browser.messengerUtilities.convertToPlainText(html.content);
    }
    return "";
  }

  async findByMessageId(accountId: string, headerMessageId: string): Promise<MessageInfo[]> {
    // A message exists once per folder it was copied to, so the first page is plenty.
    return collect(await browser.messages.query({ accountId, headerMessageId, messagesPerPage: PAGE_SIZE }), PAGE_SIZE);
  }

  async move(messageIds: number[], folder: FolderRef): Promise<void> {
    await browser.messages.move(messageIds, await this.folderId(folder));
  }
}

/** The messages of a list, across its pages. Stops reading once there are more than the limit. */
export async function collect(list: tb.MessageList, limit = Number.POSITIVE_INFINITY): Promise<MessageInfo[]> {
  const messages: MessageInfo[] = [];
  for await (const page of messagePages(list)) {
    messages.push(...page);
    if (messages.length > limit) {
      break;
    }
  }
  return messages;
}

/**
 * The messages a command acts on: the selected messages of a mail tab, or the
 * message shown in a message tab or window. With a limit, the list is read only
 * until it is known to hold more than that.
 */
export async function messagesOfTab(tab: tb.Tab | undefined, limit = Number.POSITIVE_INFINITY): Promise<MessageInfo[]> {
  if (tab?.id === undefined) {
    return [];
  }
  if (tab.type === "mail") {
    return collect(await browser.mailTabs.getSelectedMessages(tab.id), limit);
  }
  if (tab.type === "messageDisplay") {
    return collect(await browser.messageDisplay.getDisplayedMessages(tab.id), limit);
  }
  return [];
}
