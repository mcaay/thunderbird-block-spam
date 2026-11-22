// What the settings page shows: a read-only snapshot of storage plus account and
// folder facts from Thunderbird. Every change goes through the background.

import { normalizeAddress } from "../core/address";
import { chosenFolders, resolveMonitoredFolders, resolveSentFolders } from "../core/folders";
import type { ChosenFolders } from "../core/folders";
import { folderKey } from "../core/ports";
import { KEY_ACCESS_POINTS, KEY_ENTRIES, KEY_META, KEY_SETTINGS } from "../core/keys";
import type { AccessPoint, Entry, FolderRef, Settings } from "../core/types";
import { send } from "../tb/protocol";
import type { Status } from "../tb/protocol";

/** A folder with the name Thunderbird shows for it, for example "Odebrane" for /INBOX. */
export interface FolderView extends FolderRef {
  /** Display name. A folder inside another one is shown with the names of its parents. */
  name: string;
  /** The roles Thunderbird gives the folder ("inbox", "sent", "junk" and so on). They decide which lists it can join. */
  specialUse: readonly string[];
}

export interface AccountView {
  id: string;
  name: string;
  /** The user's own addresses in this account, normalized. */
  emails: string[];
  /** Real folders of the account, without the root. */
  folders: FolderView[];
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
  /** When the background last ran its periodic check. Null before the first one. */
  lastTick: number | null;
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

/**
 * The name shown for a folder: Thunderbird's own name for it, which is translated for
 * the Inbox, Sent, Junk and the like, preceded by the names of the folders it is in.
 */
export function folderDisplayName(folder: { path: string; name: string }, namesByPath: ReadonlyMap<string, string>): string {
  const segments = folder.path.split("/").filter((segment) => segment !== "");
  const names: string[] = [];
  for (let depth = 1; depth < segments.length; depth += 1) {
    const parent = `/${segments.slice(0, depth).join("/")}`;
    names.push(namesByPath.get(parent) ?? (segments[depth - 1] as string));
  }
  names.push(folder.name === "" ? (segments.at(-1) ?? folder.path) : folder.name);
  return names.join(" / ");
}

async function readAccounts(): Promise<AccountView[]> {
  const accounts = await browser.accounts.list(false);
  const views: AccountView[] = [];
  for (const account of accounts) {
    const folders = (await browser.folders.query({ accountId: account.id })).filter(
      (folder) => !folder.isRoot && !folder.isVirtual && !folder.isUnified && !folder.isTag,
    );
    const names = new Map(folders.map((folder) => [folder.path, folder.name]));
    const withUse = (use: string): FolderRef[] =>
      folders.filter((folder) => folder.specialUse.includes(use)).map((folder) => ({ accountId: account.id, path: folder.path }));
    views.push({
      id: account.id,
      name: account.name,
      emails: account.identities
        .map((identity) => normalizeAddress(identity.email ?? ""))
        .filter((email): email is string => email !== null),
      folders: folders.map((folder) => ({ accountId: account.id, path: folder.path, name: folderDisplayName(folder, names), specialUse: folder.specialUse })),
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
    browser.storage.local.get([KEY_SETTINGS, KEY_ENTRIES, KEY_ACCESS_POINTS, KEY_META]),
    loadAccounts(),
  ]);
  const lastTick = (stored[KEY_META] as { lastTick?: unknown } | undefined)?.lastTick;
  return {
    status,
    settings: status.fatal === null ? ((stored[KEY_SETTINGS] as Settings | undefined) ?? null) : null,
    entries: status.fatal === null ? ((stored[KEY_ENTRIES] as Entry[] | undefined) ?? []) : [],
    accessPoints: status.fatal === null ? ((stored[KEY_ACCESS_POINTS] as AccessPoint[] | undefined) ?? []) : [],
    accounts,
    lastTick: status.fatal === null && typeof lastTick === "number" ? lastTick : null,
  };
}

export function accountName(model: Model, accountId: string): string {
  return model.accounts.find((account) => account.id === accountId)?.name ?? accountId;
}

/** Every address of the user, across all accounts. */
export function ownAddresses(model: Model): Set<string> {
  return new Set(model.accounts.flatMap((account) => account.emails));
}

/** The name and the path of a folder. A folder that no longer exists is named by its path. */
export function folderView(model: Model, folder: FolderRef): FolderView {
  const known = model.accounts
    .find((account) => account.id === folder.accountId)
    ?.folders.find((candidate) => candidate.path === folder.path);
  return known ?? { ...folder, name: folder.path.replace(/^\//, ""), specialUse: [] };
}

/** The folders of every list as they are now for one account, its defaults included. */
export function chosenIn(account: AccountView, settings: Settings): ChosenFolders {
  return chosenFolders(account.sentDefaults, account.inboxes, settings);
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

/** The plain reference of a folder, as settings store it. */
export function folderRef(folder: FolderRef): FolderRef {
  return { accountId: folder.accountId, path: folder.path };
}
