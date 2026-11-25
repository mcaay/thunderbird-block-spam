// Which folders are watched: defaults from special uses, adjusted by the user.

import { folderKey } from "./ports";
import type { AccountSwitch, FolderRef, Settings } from "./types";

function unique(folders: readonly FolderRef[]): FolderRef[] {
  const seen = new Set<string>();
  const result: FolderRef[] = [];
  for (const folder of folders) {
    const key = folderKey(folder);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(folder);
    }
  }
  return result;
}

/** Every folder with the sent special use, plus added folders, minus removed ones. */
export function resolveSentFolders(defaults: readonly FolderRef[], settings: Settings): FolderRef[] {
  const removed = new Set(settings.sentFoldersRemoved.map(folderKey));
  return unique([...defaults, ...settings.sentFoldersAdded]).filter((folder) => !removed.has(folderKey(folder)));
}

/** The Inbox of every account, plus folders the user added. */
export function resolveMonitoredFolders(inboxes: readonly FolderRef[], settings: Settings): FolderRef[] {
  return unique([...inboxes, ...settings.monitoredFoldersAdded]);
}

// ---------------------------------------------------------------------------
// Protection per account. Every account is protected unless the user switched it off.

/** False only for an account whose protection the user switched off. */
export function accountProtected(settings: Pick<Settings, "accountSwitches">, accountId: string): boolean {
  return settings.accountSwitches.find((item) => item.accountId === accountId)?.on !== false;
}

/** When the user switched the account on again. 0 for an account that was never switched off, or is off. */
export function accountProtectedSince(settings: Pick<Settings, "accountSwitches">, accountId: string): number {
  const item = settings.accountSwitches.find((candidate) => candidate.accountId === accountId);
  return item !== undefined && item.on ? item.at : 0;
}

/** The switches with this account switched at the given time. */
export function withAccountSwitch(switches: readonly AccountSwitch[], accountId: string, on: boolean, now: number): AccountSwitch[] {
  return [...switches.filter((item) => item.accountId !== accountId), { accountId, on, at: now }];
}

/**
 * The folders whose new mail is handled: the monitored folders of the accounts that are protected.
 * What is done by hand (a shortcut, the log) does not ask this: it works in every account.
 */
export function resolveProtectedFolders(inboxes: readonly FolderRef[], settings: Settings): FolderRef[] {
  return resolveMonitoredFolders(inboxes, settings).filter((folder) => accountProtected(settings, folder.accountId));
}

// ---------------------------------------------------------------------------
// Which folder can be right in which list. A menu offers only those, and the
// background refuses the others, so the rule does not live in a page alone.

/** A folder with the roles Thunderbird gives it: "inbox", "sent", "junk", "trash", "drafts", "templates", "outbox", "archives". */
export interface FolderFacts extends FolderRef {
  specialUse: readonly string[];
}

/** The three lists of folders a user chooses. */
export type FolderList = "sent" | "monitored" | "screening";

/**
 * The roles in Thunderbird that rule a folder out. An Inbox on the Sent list would
 * put the recipients of incoming mail on the white list; Junk and Trash hold mail
 * that was dealt with; Drafts, Templates and the Outbox hold mail that was not sent.
 */
const RULED_OUT: Record<FolderList, readonly string[]> = {
  sent: ["inbox", "junk", "trash", "drafts", "templates", "outbox"],
  monitored: ["sent", "junk", "trash", "drafts", "templates", "outbox"],
  screening: ["inbox", "sent", "junk", "trash", "drafts", "templates", "outbox"],
};

/** The folders that are on each list now, the defaults included. */
export interface ChosenFolders {
  sent: readonly FolderRef[];
  monitored: readonly FolderRef[];
  screening: readonly FolderRef[];
}

export function chosenFolders(sentDefaults: readonly FolderRef[], inboxes: readonly FolderRef[], settings: Settings): ChosenFolders {
  return {
    sent: resolveSentFolders(sentDefaults, settings),
    monitored: resolveMonitoredFolders(inboxes, settings),
    screening: settings.screeningFolders,
  };
}

function has(list: readonly FolderRef[], folder: FolderRef): boolean {
  const key = folderKey(folder);
  return list.some((item) => folderKey(item) === key);
}

const OTHER_LISTS: Record<FolderList, readonly FolderList[]> = {
  sent: ["monitored", "screening"],
  monitored: ["sent", "screening"],
  screening: ["sent", "monitored"],
};

/**
 * Whether a folder can be put on a list: its role in Thunderbird does not rule it
 * out, and it is on neither of the other two lists. A folder has one job at most.
 */
export function mayJoin(list: FolderList, folder: FolderFacts, chosen: ChosenFolders): boolean {
  return !folder.specialUse.some((use) => RULED_OUT[list].includes(use)) && !OTHER_LISTS[list].some((other) => has(chosen[other], folder));
}

/** The folders a menu offers for a list: those that may join it and are not on it yet. */
export function folderCandidates<Folder extends FolderFacts>(list: FolderList, folders: readonly Folder[], chosen: ChosenFolders): Folder[] {
  return folders.filter((folder) => !has(chosen[list], folder) && mayJoin(list, folder, chosen));
}

/**
 * The folders a change of the settings puts on a list although the rule excludes them.
 * A folder that was on the list before the change is never refused: what is stored
 * stays listed and removable, whatever its role. A folder Thunderbird does not know
 * (any more) has no role and is refused only when it is on another list.
 */
export function refusedFolders(
  before: Settings,
  after: Settings,
  folders: readonly FolderFacts[],
  sentDefaults: readonly FolderRef[],
  inboxes: readonly FolderRef[],
): FolderRef[] {
  const chosen = chosenFolders(sentDefaults, inboxes, after);
  const stored: Record<FolderList, [readonly FolderRef[], readonly FolderRef[]]> = {
    sent: [before.sentFoldersAdded, after.sentFoldersAdded],
    monitored: [before.monitoredFoldersAdded, after.monitoredFoldersAdded],
    screening: [before.screeningFolders, after.screeningFolders],
  };
  const refused: FolderRef[] = [];
  for (const list of ["sent", "monitored", "screening"] as const) {
    const [was, is] = stored[list];
    for (const folder of is) {
      if (has(was, folder)) {
        continue;
      }
      const facts = folders.find((item) => folderKey(item) === folderKey(folder)) ?? { ...folder, specialUse: [] };
      if (!mayJoin(list, facts, chosen) && !has(refused, folder)) {
        refused.push(folder);
      }
    }
  }
  return refused;
}

/**
 * Where the screening folder that Block Spam creates can be: at the top of the
 * account, or inside the Inbox on servers that allow folders only there.
 */
export function screeningFolderPaths(name: string, inboxes: readonly FolderRef[], accountId: string): string[] {
  return [`/${name}`, ...inboxes.filter((inbox) => inbox.accountId === accountId).map((inbox) => `${inbox.path}/${name}`)];
}
