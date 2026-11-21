// What the settings page shows: a read-only snapshot of storage plus account and
// folder facts from Thunderbird. Every change goes through the background.

import { resolveMonitoredFolders, resolveSentFolders } from "../core/folders";
import { folderKey } from "../core/ports";
import { KEY_ACCESS_POINTS, KEY_ENTRIES, KEY_SETTINGS } from "../core/keys";
import type { AccessPoint, Entry, FolderRef, Settings } from "../core/types";
import { send } from "../tb/protocol";
import type { Status } from "../tb/protocol";

export interface AccountView {
  id: string;
  name: string;
  /** Real folders of the account, without the root. */
  folders: FolderRef[];
  inboxes: FolderRef[];
  sentDefaults: FolderRef[];
  hasJunk: boolean;
}

export interface Model {
  status: Status;
  /** Null only when stored data is invalid. */
  settings: Settings | null;
  entries: Entry[];
  accessPoints: AccessPoint[];
  accounts: AccountView[];
}

const ACCOUNTS_MAX_AGE_MS = 15 * 1000;
let accountsCache: { time: number; views: Promise<AccountView[]> } | null = null;

/** Accounts and folders change rarely, and reading them takes one query per account. */
function loadAccounts(): Promise<AccountView[]> {
  if (accountsCache === null || Date.now() - accountsCache.time > ACCOUNTS_MAX_AGE_MS) {
    accountsCache = { time: Date.now(), views: readAccounts() };
    accountsCache.views.catch(() => {
      accountsCache = null;
    });
  }
  return accountsCache.views;
}

/** Forgets the cached accounts, for example after a folder was created. */
export function forgetAccounts(): void {
  accountsCache = null;
}

async function readAccounts(): Promise<AccountView[]> {
  const accounts = await browser.accounts.list(false);
  const views: AccountView[] = [];
  for (const account of accounts) {
    const folders = (await browser.folders.query({ accountId: account.id })).filter(
      (folder) => !folder.isRoot && !folder.isVirtual && !folder.isUnified && !folder.isTag,
    );
    const withUse = (use: string): FolderRef[] =>
      folders.filter((folder) => folder.specialUse.includes(use)).map((folder) => ({ accountId: account.id, path: folder.path }));
    views.push({
      id: account.id,
      name: account.name,
      folders: folders.map((folder) => ({ accountId: account.id, path: folder.path })),
      inboxes: withUse("inbox"),
      sentDefaults: withUse("sent"),
      hasJunk: withUse("junk").length > 0,
    });
  }
  return views;
}

export async function loadModel(): Promise<Model> {
  const [status, stored, accounts] = await Promise.all([
    send("getStatus", {}),
    browser.storage.local.get([KEY_SETTINGS, KEY_ENTRIES, KEY_ACCESS_POINTS]),
    loadAccounts(),
  ]);
  return {
    status,
    settings: status.fatal === null ? ((stored[KEY_SETTINGS] as Settings | undefined) ?? null) : null,
    entries: (stored[KEY_ENTRIES] as Entry[] | undefined) ?? [],
    accessPoints: (stored[KEY_ACCESS_POINTS] as AccessPoint[] | undefined) ?? [],
    accounts,
  };
}

export function accountName(model: Model, accountId: string): string {
  return model.accounts.find((account) => account.id === accountId)?.name ?? accountId;
}

export function sentFolders(account: AccountView, settings: Settings): FolderRef[] {
  return resolveSentFolders(account.sentDefaults, settings).filter((folder) => folder.accountId === account.id);
}

export function monitoredFolders(account: AccountView, settings: Settings): FolderRef[] {
  return resolveMonitoredFolders(account.inboxes, settings).filter((folder) => folder.accountId === account.id);
}

export function hasFolder(list: readonly FolderRef[], folder: FolderRef): boolean {
  return list.some((item) => folderKey(item) === folderKey(folder));
}

export function withoutFolder(list: readonly FolderRef[], folder: FolderRef): FolderRef[] {
  return list.filter((item) => folderKey(item) !== folderKey(folder));
}

/** Folder paths are shown without the leading slash. */
export function folderLabel(folder: FolderRef): string {
  return folder.path.replace(/^\//, "");
}
