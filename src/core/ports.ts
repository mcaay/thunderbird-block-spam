// Interfaces the core logic needs from the outside world. The Thunderbird layer
// implements them with real APIs, the tests with in-memory fakes.

import type { AccessPoint, AccountInfo, FolderRef, Identity, MessageInfo } from "./types";

export type SpecialUse = "inbox" | "sent" | "junk";

export interface MailPort {
  accounts(): Promise<AccountInfo[]>;
  identities(): Promise<Identity[]>;
  /** Folders with the given special use, across all accounts. */
  specialFolders(use: SpecialUse): Promise<FolderRef[]>;
  /** Pages of messages in a folder dated after `since` and, when given, before `until`. */
  messagesSince(folder: FolderRef, since: number, until?: number): AsyncIterable<MessageInfo[]>;
  /** Pages of all messages in a folder. */
  allMessages(folder: FolderRef): AsyncIterable<MessageInfo[]>;
  /** Addresses contained in one or more mailbox header values. */
  parseAddresses(raw: string): Promise<string[]>;
  /** All headers of a message, keyed by lowercase name. */
  headers(messageId: number): Promise<Record<string, string[]>>;
  /** Raw From value of the first attached message (message/rfc822), or null. */
  attachedMessageFrom(messageId: number): Promise<string | null>;
  /** Plain-text body: plain text preferred, otherwise HTML converted to text. */
  bodyText(messageId: number): Promise<string>;
  /** Moves messages. Rejects when the move fails. */
  move(messageIds: number[], folder: FolderRef): Promise<void>;
}

export interface AiPort {
  /**
   * Scores a payload with one access point and returns a number from 0.00 to 1.00.
   * Rejects with an AccessPointError.
   */
  score(point: AccessPoint, prompt: string, payload: string): Promise<number>;
}

/** Persistent key-value storage, written through one serialized queue. */
export interface KeyValueStore {
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export function folderKey(folder: FolderRef): string {
  return `${folder.accountId} ${folder.path}`;
}

export function sameFolder(a: FolderRef | null, b: FolderRef | null): boolean {
  return a !== null && b !== null && a.accountId === b.accountId && a.path === b.path;
}
