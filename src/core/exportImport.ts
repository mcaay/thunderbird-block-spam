// Export and import (design section 10). One JSON file with the lists, the settings
// and the access point definitions without secrets. Account-scoped entries and
// folder choices are exported with the account's email address.

import { addEntry, entriesFromArray, keyOf } from "./lists";
import type { EntryMap } from "./lists";
import { folderKey } from "./ports";
import {
  ACCESS_POINT_TYPES,
  asArray,
  asBoolean,
  asOneOf,
  asRecord,
  asString,
  validateCutoff,
  validateEntry,
  validatePrompt,
  ValidationError,
} from "./settings";
import { applySettingsPatch } from "./edit";
import type { SettingsPatch } from "./edit";
import { SCOPE_ALL } from "./types";
import type { AccessPoint, AccessPointType, AccountInfo, Entry, FolderRef, Settings } from "./types";

export const EXPORT_FORMAT = "block-spam-export";
export const EXPORT_VERSION = 1;

/** A folder outside this computer: the account by its email address, plus the path. */
export interface ExportedFolder {
  account: string;
  path: string;
}

export interface ExportedEntry extends Omit<Entry, "scope"> {
  scope: "all" | { account: string };
}

export interface ExportedAccessPoint {
  type: AccessPointType;
  name: string;
  enabled: boolean;
  endpoint: string;
  model: string;
}

export interface ExportedSettings {
  observation: boolean;
  newEntryScope: Settings["newEntryScope"];
  noVerdictAction: Settings["noVerdictAction"];
  smart: boolean;
  cutoff: number;
  prompt: string;
  publicDomainsAdded: string[];
  publicDomainsRemoved: string[];
  forwardingMailboxes: string[];
  forwardLabels: string[];
  sentFoldersAdded: ExportedFolder[];
  sentFoldersRemoved: ExportedFolder[];
  monitoredFoldersAdded: ExportedFolder[];
  screeningFolders: ExportedFolder[];
}

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  entries: ExportedEntry[];
  settings: ExportedSettings;
  accessPoints: ExportedAccessPoint[];
}

/** How an account is named in an export: its email address, or its name when it has no identity. */
export function accountReference(account: AccountInfo): string {
  return account.email ?? `name:${account.name}`;
}

export interface ExportResult {
  file: ExportFile;
  /** Entries and folder choices of accounts that no longer exist. They are left out. */
  skipped: number;
}

export function buildExport(
  source: { settings: Settings; entries: EntryMap; accessPoints: readonly AccessPoint[] },
  accounts: readonly AccountInfo[],
  now: number,
): ExportResult {
  const references = new Map(accounts.map((account) => [account.id, accountReference(account)]));
  let skipped = 0;

  const entries: ExportedEntry[] = [];
  for (const entry of source.entries.values()) {
    if (entry.scope === SCOPE_ALL) {
      entries.push({ ...entry, scope: "all" });
      continue;
    }
    const account = references.get(entry.scope);
    if (account === undefined) {
      skipped += 1;
    } else {
      entries.push({ ...entry, scope: { account } });
    }
  }

  const folders = (list: readonly FolderRef[]): ExportedFolder[] => {
    const result: ExportedFolder[] = [];
    for (const folder of list) {
      const account = references.get(folder.accountId);
      if (account === undefined) {
        skipped += 1;
      } else {
        result.push({ account, path: folder.path });
      }
    }
    return result;
  };

  const { settings } = source;
  return {
    skipped,
    file: {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date(now).toISOString(),
      entries,
      settings: {
        observation: settings.observation,
        newEntryScope: settings.newEntryScope,
        noVerdictAction: settings.noVerdictAction,
        smart: settings.smart,
        cutoff: settings.cutoff,
        prompt: settings.prompt,
        publicDomainsAdded: [...settings.publicDomainsAdded],
        publicDomainsRemoved: [...settings.publicDomainsRemoved],
        forwardingMailboxes: [...settings.forwardingMailboxes],
        forwardLabels: [...settings.forwardLabels],
        sentFoldersAdded: folders(settings.sentFoldersAdded),
        sentFoldersRemoved: folders(settings.sentFoldersRemoved),
        monitoredFoldersAdded: folders(settings.monitoredFoldersAdded),
        screeningFolders: folders(settings.screeningFolders),
      },
      // Secrets (API keys, sign-in tokens) and temporary state are never exported.
      accessPoints: source.accessPoints.map((point) => ({
        type: point.type,
        name: point.name,
        enabled: point.enabled,
        endpoint: point.endpoint,
        model: point.model,
      })),
    },
  };
}

export type ImportMode = "merge" | "replace";

export interface SkippedItem {
  /** What was skipped: "entry", "sentFolder", "monitoredFolder" or "screeningFolder". */
  kind: string;
  /** The entry value or folder path. */
  item: string;
  /** The account reference that was not found, or "" when the folder is missing. */
  account: string;
}

export interface ImportReport {
  mode: ImportMode;
  entriesAdded: number;
  entriesReplaced: number;
  entriesUnchanged: number;
  skipped: SkippedItem[];
  accessPoints: number;
}

export interface ImportTarget {
  settings: Settings;
  entries: EntryMap;
  accessPoints: AccessPoint[];
}

export interface ImportContext {
  accounts: readonly AccountInfo[];
  /** Keys (see folderKey) of the folders that exist locally. */
  folders: ReadonlySet<string>;
  newId: () => string;
  /** True when an access point of this definition cannot work without a secret. */
  needsSecret: (definition: ExportedAccessPoint) => boolean;
}

function parseFolder(value: unknown, path: string): ExportedFolder {
  const record = asRecord(value, path);
  return { account: asString(record.account, `${path}.account`), path: asString(record.path, `${path}.path`) };
}

function parseFile(value: unknown): ExportFile {
  const record = asRecord(value, "file");
  if (record.format !== EXPORT_FORMAT) {
    throw new ValidationError("file: this is not a Block Spam export");
  }
  if (record.version !== EXPORT_VERSION) {
    throw new ValidationError(`file.version: found ${String(record.version)}, this version of the add-on understands ${EXPORT_VERSION}`);
  }
  const settings = asRecord(record.settings, "file.settings");
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: typeof record.exportedAt === "string" ? record.exportedAt : "",
    entries: asArray(record.entries, "file.entries", (item, path) => {
      const entry = asRecord(item, path);
      const scope = entry.scope === "all" ? "all" : { account: asString(asRecord(entry.scope, `${path}.scope`).account, `${path}.scope.account`) };
      // Validate everything but the scope, which is mapped to a local account later.
      const checked = validateEntry({ ...entry, scope: "all" }, path);
      return { ...checked, scope };
    }),
    settings: {
      observation: asBoolean(settings.observation, "file.settings.observation"),
      newEntryScope: asOneOf(settings.newEntryScope, ["shared", "account"] as const, "file.settings.newEntryScope"),
      noVerdictAction: asOneOf(settings.noVerdictAction, ["leave", "junk", "screening"] as const, "file.settings.noVerdictAction"),
      smart: asBoolean(settings.smart, "file.settings.smart"),
      cutoff: validateCutoff(settings.cutoff, "file.settings.cutoff"),
      prompt: validatePrompt(settings.prompt, "file.settings.prompt"),
      publicDomainsAdded: asArray(settings.publicDomainsAdded, "file.settings.publicDomainsAdded", asString),
      publicDomainsRemoved: asArray(settings.publicDomainsRemoved, "file.settings.publicDomainsRemoved", asString),
      forwardingMailboxes: asArray(settings.forwardingMailboxes, "file.settings.forwardingMailboxes", asString),
      forwardLabels: asArray(settings.forwardLabels, "file.settings.forwardLabels", asString),
      sentFoldersAdded: asArray(settings.sentFoldersAdded, "file.settings.sentFoldersAdded", parseFolder),
      sentFoldersRemoved: asArray(settings.sentFoldersRemoved, "file.settings.sentFoldersRemoved", parseFolder),
      monitoredFoldersAdded: asArray(settings.monitoredFoldersAdded, "file.settings.monitoredFoldersAdded", parseFolder),
      screeningFolders: asArray(settings.screeningFolders, "file.settings.screeningFolders", parseFolder),
    },
    accessPoints: asArray(record.accessPoints, "file.accessPoints", (item, path) => {
      const point = asRecord(item, path);
      return {
        type: asOneOf(point.type, ACCESS_POINT_TYPES, `${path}.type`),
        name: asString(point.name, `${path}.name`),
        enabled: asBoolean(point.enabled, `${path}.enabled`),
        endpoint: asString(point.endpoint, `${path}.endpoint`),
        model: asString(point.model, `${path}.model`),
      };
    }),
  };
}

/**
 * Imports a file into the target, which is changed in place only when the whole
 * file is valid.
 *
 * Merge unites the lists and leaves settings and access points untouched: an
 * imported entry replaces an existing entry with the same key in the other list.
 * Replace overwrites lists, settings and access point definitions. In both modes
 * account-scoped items are attached to the local account with the same email
 * address, and items whose account is not found are skipped and reported.
 */
export function applyImport(
  target: ImportTarget,
  rawFile: unknown,
  mode: ImportMode,
  context: ImportContext,
): ImportReport {
  const file = parseFile(rawFile);
  const accountIds = new Map<string, string>();
  for (const account of context.accounts) {
    const reference = accountReference(account);
    if (!accountIds.has(reference)) {
      accountIds.set(reference, account.id);
    }
  }
  const report: ImportReport = {
    mode,
    entriesAdded: 0,
    entriesReplaced: 0,
    entriesUnchanged: 0,
    skipped: [],
    accessPoints: 0,
  };

  const imported: Entry[] = [];
  for (const entry of file.entries) {
    if (entry.scope === "all") {
      imported.push({ ...entry, scope: SCOPE_ALL });
      continue;
    }
    const accountId = accountIds.get(entry.scope.account);
    if (accountId === undefined) {
      report.skipped.push({ kind: "entry", item: entry.value, account: entry.scope.account });
    } else {
      imported.push({ ...entry, scope: accountId });
    }
  }

  if (mode === "merge") {
    for (const entry of imported) {
      const existing = target.entries.get(keyOf(entry));
      if (existing === undefined) {
        target.entries.set(keyOf(entry), entry);
        report.entriesAdded += 1;
      } else if (existing.list !== entry.list) {
        target.entries.set(keyOf(entry), entry);
        report.entriesReplaced += 1;
      } else {
        report.entriesUnchanged += 1;
      }
    }
    return report;
  }

  const folders = (list: readonly ExportedFolder[], kind: string): FolderRef[] => {
    const result: FolderRef[] = [];
    for (const folder of list) {
      const accountId = accountIds.get(folder.account);
      if (accountId === undefined) {
        report.skipped.push({ kind, item: folder.path, account: folder.account });
        continue;
      }
      const local = { accountId, path: folder.path };
      if (!context.folders.has(folderKey(local))) {
        report.skipped.push({ kind, item: folder.path, account: "" });
        continue;
      }
      result.push(local);
    }
    return result;
  };

  const screening: FolderRef[] = [];
  for (const folder of folders(file.settings.screeningFolders, "screeningFolder")) {
    if (!screening.some((existing) => existing.accountId === folder.accountId)) {
      screening.push(folder);
    }
  }
  const patch: SettingsPatch = {
    observation: file.settings.observation,
    newEntryScope: file.settings.newEntryScope,
    noVerdictAction: file.settings.noVerdictAction,
    smart: file.settings.smart,
    cutoff: file.settings.cutoff,
    prompt: file.settings.prompt,
    publicDomainsAdded: file.settings.publicDomainsAdded,
    publicDomainsRemoved: file.settings.publicDomainsRemoved,
    forwardingMailboxes: file.settings.forwardingMailboxes,
    forwardLabels: file.settings.forwardLabels,
    sentFoldersAdded: folders(file.settings.sentFoldersAdded, "sentFolder"),
    sentFoldersRemoved: folders(file.settings.sentFoldersRemoved, "sentFolder"),
    monitoredFoldersAdded: folders(file.settings.monitoredFoldersAdded, "monitoredFolder"),
    screeningFolders: screening,
  };
  // Validates the imported settings. Protection, the installation time and other
  // local state are kept: importing never switches protection on.
  const { settings } = applySettingsPatch(target.settings, patch);

  const replaced = entriesFromArray([]);
  for (const entry of imported) {
    const result = addEntry(replaced, entry, entry.addedAt);
    if (result === "added") {
      report.entriesAdded += 1;
    }
  }

  const accessPoints: AccessPoint[] = file.accessPoints.map((definition) => ({
    id: context.newId(),
    type: definition.type,
    name: definition.name,
    enabled: definition.enabled,
    endpoint: definition.endpoint,
    model: definition.model,
    apiKey: "",
    auth: null,
    cooldownUntil: 0,
    // Keys must be entered again and ChatGPT sign-in repeated.
    needsAttention: context.needsSecret(definition),
    lastError: "",
  }));
  report.accessPoints = accessPoints.length;

  target.settings = settings;
  target.entries.clear();
  for (const [key, entry] of replaced) {
    target.entries.set(key, entry);
  }
  target.accessPoints = accessPoints;
  return report;
}
