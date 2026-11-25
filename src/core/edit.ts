// Validation of edits that arrive from the settings page. The background applies
// them; the page never writes storage itself.

import { normalizeAddress, normalizeDomain, registrableDomain } from "./address";
import type { NewEntry } from "./lists";
import { folderKey } from "./ports";
import { roundScore } from "./score";
import {
  asArray,
  asBoolean,
  asOneOf,
  asRecord,
  asString,
  normalizeAddressList,
  normalizeDomainList,
  validateCutoff,
  validatePrompt,
  ValidationError,
} from "./settings";
import { SCOPE_ALL } from "./types";
import type { EntryKind, FolderRef, NewEntryScope, NoVerdictAction, Settings } from "./types";

export const FORWARD_LABEL_LIMIT = 40;

/** The settings a user can edit. Every key is optional. */
export interface SettingsPatch {
  observation?: boolean;
  newEntryScope?: NewEntryScope;
  noVerdictAction?: NoVerdictAction;
  smart?: boolean;
  periodicCheck?: boolean;
  cutoff?: number;
  prompt?: string;
  publicDomainsAdded?: string[];
  publicDomainsRemoved?: string[];
  forwardingMailboxes?: string[];
  forwardLabels?: string[];
  sentFoldersAdded?: FolderRef[];
  sentFoldersRemoved?: FolderRef[];
  monitoredFoldersAdded?: FolderRef[];
  screeningFolders?: FolderRef[];
}

function folderList(value: unknown, path: string): FolderRef[] {
  const seen = new Set<string>();
  const result: FolderRef[] = [];
  for (const item of asArray(value, path, (element, at) => {
    const record = asRecord(element, at);
    return { accountId: asString(record.accountId, `${at}.accountId`), path: asString(record.path, `${at}.path`) };
  })) {
    if (item.accountId === "" || item.path === "") {
      throw new ValidationError(`${path}: a folder needs an account and a path`);
    }
    if (!seen.has(folderKey(item))) {
      seen.add(folderKey(item));
      result.push(item);
    }
  }
  return result;
}

function stringList(value: unknown, path: string): string[] {
  return asArray(value, path, asString);
}

/**
 * Applies a patch to a copy of the settings. Lists are normalized; items that are
 * not valid are left out and returned in `invalid`. A wrong type, an unknown key,
 * an empty prompt or a cutoff outside 0.00 to 1.00 throws.
 */
export function applySettingsPatch(current: Settings, patch: unknown): { settings: Settings; invalid: string[] } {
  const input = asRecord(patch, "patch");
  const settings: Settings = structuredClone(current);
  const invalid: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case "observation":
        settings.observation = asBoolean(value, key);
        break;
      case "smart":
        settings.smart = asBoolean(value, key);
        break;
      case "periodicCheck":
        settings.periodicCheck = asBoolean(value, key);
        break;
      case "newEntryScope":
        settings.newEntryScope = asOneOf<NewEntryScope>(value, ["shared", "account"], key);
        break;
      case "noVerdictAction":
        settings.noVerdictAction = asOneOf<NoVerdictAction>(value, ["leave", "junk", "screening"], key);
        break;
      case "cutoff":
        settings.cutoff = roundScore(validateCutoff(value, key));
        break;
      case "prompt":
        settings.prompt = validatePrompt(value, key);
        break;
      case "publicDomainsAdded":
      case "publicDomainsRemoved": {
        const result = normalizeDomainList(stringList(value, key));
        invalid.push(...result.invalid);
        settings[key] = result.valid.sort();
        break;
      }
      case "forwardingMailboxes": {
        const result = normalizeAddressList(stringList(value, key));
        invalid.push(...result.invalid);
        settings.forwardingMailboxes = result.valid.sort();
        break;
      }
      case "forwardLabels": {
        const labels = new Set<string>();
        for (const raw of stringList(value, key)) {
          const label = raw.trim();
          if (label === "") {
            continue;
          }
          if (label.length > FORWARD_LABEL_LIMIT || /[\r\n]/.test(label)) {
            invalid.push(label);
          } else {
            labels.add(label);
          }
        }
        settings.forwardLabels = [...labels];
        break;
      }
      case "sentFoldersAdded":
      case "sentFoldersRemoved":
      case "monitoredFoldersAdded":
        settings[key] = folderList(value, key);
        break;
      case "screeningFolders": {
        const folders = folderList(value, key);
        if (new Set(folders.map((folder) => folder.accountId)).size !== folders.length) {
          throw new ValidationError("screeningFolders: at most one folder per account");
        }
        settings.screeningFolders = folders;
        break;
      }
      default:
        throw new ValidationError(`patch: unknown setting ${key}`);
    }
  }

  // A domain is either added or removed, never both. The latest edit wins.
  if ("publicDomainsAdded" in input && !("publicDomainsRemoved" in input)) {
    const added = new Set(settings.publicDomainsAdded);
    settings.publicDomainsRemoved = settings.publicDomainsRemoved.filter((domain) => !added.has(domain));
  } else {
    const removed = new Set(settings.publicDomainsRemoved);
    settings.publicDomainsAdded = settings.publicDomainsAdded.filter((domain) => !removed.has(domain));
  }
  return { settings, invalid };
}

export interface ManualEntryInput {
  list: unknown;
  /** Left out by the settings page: the kind then follows from the value. */
  kind?: unknown;
  value: unknown;
  scope: unknown;
}

/**
 * The kind of a value typed by the user: with a name before an "@" it is an address,
 * anything else is a domain, also "@example.com".
 */
export function inferKind(raw: string): EntryKind {
  return raw.trim().lastIndexOf("@") > 0 ? "address" : "domain";
}

/**
 * An entry added by hand in settings. The scope is chosen explicitly. A domain is
 * stored as its registrable domain, because that is what senders are matched by.
 * Mistakes a user can make carry a code that the page translates.
 */
export function manualEntry(input: ManualEntryInput, accountIds: readonly string[]): NewEntry {
  const list = asOneOf(input.list, ["white", "black"] as const, "list");
  const raw = asString(input.value, "value");
  const kind = input.kind === undefined ? inferKind(raw) : asOneOf(input.kind, ["address", "domain"] as const, "kind");
  const scope = asString(input.scope, "scope");
  if (scope !== SCOPE_ALL && !accountIds.includes(scope)) {
    throw new ValidationError("scope: unknown account", "account-unknown");
  }
  let value: string | null;
  if (kind === "address") {
    value = normalizeAddress(raw);
    if (value === null) {
      throw new ValidationError("value: not an email address", "entry-invalid");
    }
  } else {
    const domain = normalizeDomain(raw);
    if (domain === null) {
      throw new ValidationError("value: not a domain", "entry-invalid");
    }
    value = registrableDomain(domain);
  }
  return { list, kind, value, scope, source: "manual" };
}
