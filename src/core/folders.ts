// Which folders are watched: defaults from special uses, adjusted by the user.

import { folderKey } from "./ports";
import type { FolderRef, Settings } from "./types";

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
