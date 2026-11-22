// Messages between the settings page, the popup and the background page. The pages
// never write storage: every change is a request to the background.

import type { AccessPointDefinition } from "../ai/presets";
import type { ModelOption } from "../ai/openaiChat";
import type { CommandName } from "../core/commands";
import type { SettingsPatch } from "../core/edit";
import type {
  AccessPointTestResult,
  CommandUndo,
  LogActionOutcome,
  LogActionUndo,
  MoveResult,
  ScanProgress,
  SenderInfo,
  TestScoreSummary,
} from "../core/engine";
import type { ExportResult, ImportMode, ImportReport } from "../core/exportImport";
import type { LogAction } from "../core/logAction";
import type { WishOutcome } from "../core/protectionWish";
import type { Entry, EntryKind, ListName, LogEntry } from "../core/types";

/** Where a block or trust command came from. */
export type CommandSource = "popup" | "shortcut" | "menu" | "keys";

/** What a block or trust command did. The popup shows it, with Undo while it can be taken back. */
export interface CommandRecord {
  id: string;
  time: number;
  source: CommandSource;
  /** What was done, one fact per line, in the language of the interface. */
  lines: string[];
  failed: boolean;
  /** True while the command changed something that can be taken back. */
  undoable: boolean;
}

/** A command as the background keeps it until it is undone, dismissed or replaced by the next one. */
export interface StoredCommand extends CommandRecord {
  undo: CommandUndo;
}

export interface Requests {
  getStatus: { request: Record<string, never>; result: Status };
  /** Switches protection now. A wish that waited for the scan is settled by it. */
  setProtection: { request: { on: boolean }; result: null };
  /**
   * Switches protection on when the scan of the sent mail has finished without an error: the scan that is
   * running, or else a scan of everything that is started here. The wish is stored and survives a restart.
   */
  protectAfterScan: { request: Record<string, never>; result: null };
  /** Calls that wish off, and forgets what the last one came to. */
  clearProtectionWish: { request: Record<string, never>; result: null };
  updateSettings: { request: { patch: SettingsPatch }; result: { invalid: string[] } };
  /** Without a kind, a value with a name before an "@" is an address and anything else a domain. */
  addEntry: {
    request: { list: string; kind?: string; value: string; scope: string };
    result: { value: string; kind: EntryKind; list: ListName; result: string };
  };
  removeEntries: { request: { keys: string[] }; result: { removed: number } };
  /** Undo of a removal: puts entries back exactly as they were. */
  restoreEntries: { request: { entries: Entry[] }; result: { restored: number } };
  /** Undoes the decision of one log entry: trusts or blocks its sender and moves its message. */
  logAction: { request: { entry: LogEntry; action: LogAction }; result: LogActionOutcome };
  undoLogAction: { request: { undo: LogActionUndo }; result: { move: MoveResult; failure: string } };
  startScan: { request: { from: number | null; to: number | null }; result: null };
  cancelScan: { request: Record<string, never>; result: null };
  createScreeningFolder: { request: { accountId: string }; result: { path: string } };
  saveAccessPoint: {
    request: { id: string | null; definition: AccessPointDefinition; apiKey: string | null };
    result: { id: string };
  };
  removeAccessPoint: { request: { id: string }; result: { revocationConfirmed: boolean } };
  moveAccessPoint: { request: { id: string; direction: -1 | 1 }; result: null };
  testAccessPoint: { request: { id: string }; result: AccessPointTestResult };
  listModels: { request: { id: string }; result: ModelOption[] };
  /** The models of a definition that is being edited and may not be saved yet. Without a key, the stored one is used. */
  listModelsFor: {
    request: { id: string | null; definition: AccessPointDefinition; apiKey: string | null };
    result: ModelOption[];
  };
  startSignIn: { request: { accessPointId: string | null; openTab: boolean }; result: { url: string } };
  finishSignIn: { request: { url: string }; result: null };
  cancelSignIn: { request: Record<string, never>; result: null };
  signOut: { request: { id: string }; result: { revocationConfirmed: boolean } };
  clearLog: { request: Record<string, never>; result: null };
  exportData: { request: Record<string, never>; result: ExportResult };
  importData: { request: { file: unknown; mode: ImportMode }; result: ImportReport };
  resetData: { request: Record<string, never>; result: null };
  /**
   * The selection of a tab: how many messages, counted up to one more than the limit
   * of a scoring run, and for a single message the sender the commands would act on.
   */
  selection: { request: { tabId: number }; result: { count: number; limit: number; sender: SenderInfo | null } };
  /** Runs one of the four shortcut commands on the selection of a tab. The lines say what was done. */
  runCommand: { request: { command: CommandName; tabId: number }; result: CommandRecord };
  /** The last command made by hand that can still be taken back, from the popup, a shortcut or the context menu. */
  lastCommand: { request: Record<string, never>; result: { command: CommandRecord | null } };
  /** Takes that command back: the lists exactly as they were, and the messages to where they were. */
  undoCommand: { request: { id: string }; result: { lines: string[]; failed: boolean } };
  /** Forgets that command without taking it back. */
  dismissCommand: { request: { id: string }; result: null };
  /** Opens the message of a log entry in a tab. Not found when it was deleted, or moved out of the account. */
  showMessage: { request: { accountId: string; messageId: string }; result: { found: boolean } };
  /** While stored data is not valid: sets one stored setting back to its default. Only settings named in the status. */
  repairSetting: { request: { name: string }; result: null };
  scoreSelected: { request: { tabId: number }; result: TestScoreSummary & { selected: number } };
  /** Asks the settings page, open or about to open, to show a pane, and in the log one entry. */
  showInSettings: { request: SettingsTarget; result: null };
  /** What the settings page was asked to show, once. */
  takeSettingsTarget: { request: Record<string, never>; result: { target: SettingsTarget | null } };
  welcomeShown: { request: Record<string, never>; result: null };
}

export type RequestName = keyof Requests;

export interface Envelope<Name extends RequestName = RequestName> {
  blockSpam: Name;
  args: Requests[Name]["request"];
}

/** A failed request carries the background's message and, for mistakes a user can make, a code the pages translate. */
export type Reply<Result> = { ok: true; result: Result } | { ok: false; error: string; code?: string };

/** What the popup wants to see in the settings page: a pane, and in the log one entry (see logEntryKey). */
export interface SettingsTarget {
  pane: string;
  logKey: string | null;
}

/** What the background tells open pages without being asked. */
export interface PageEvent {
  blockSpamEvent: "show";
  target: SettingsTarget;
}

export function isPageEvent(message: unknown): message is PageEvent {
  const target = (message as PageEvent | null)?.target;
  return (
    typeof message === "object" &&
    message !== null &&
    (message as PageEvent).blockSpamEvent === "show" &&
    typeof target === "object" &&
    target !== null &&
    typeof target.pane === "string" &&
    (target.logKey === null || typeof target.logKey === "string")
  );
}

/** A request the background refused. */
export class RequestError extends Error {
  /** Set for mistakes a user can make, see ValidationError. Otherwise empty. */
  readonly code: string;

  constructor(message: string, code = "") {
    super(message);
    this.name = "RequestError";
    this.code = code;
  }
}

export interface SignInStatus {
  /** The authorization address of the attempt in progress, or null. */
  url: string | null;
  /** Why the last attempt failed, or "". */
  error: string;
  /** The redirect could be captured automatically (the webRequest permission is present). */
  capture: boolean;
  /** The service the attempt signs in again, or null when it adds a new one. */
  accessPointId: string | null;
}

export interface Status {
  /** Set when stored data failed validation. Protection is off and nothing is written. */
  fatal: string | null;
  /**
   * With invalid stored data: the settings whose stored value is not valid, when they
   * are all that is wrong and each can be set back to its default. Null otherwise.
   */
  repair: string[] | null;
  scan: ScanProgress | null;
  signIn: SignInStatus;
  /** A test of selected messages is running. */
  scoring: boolean;
  /** "Switch protection on" that waits for the scan: whether one is waiting, and what the last one came to until the user has seen it. */
  wish: { waiting: boolean; outcome: WishOutcome | null };
}

/** Sends a request to the background and returns its result. Rejects with the background's error message. */
export async function send<Name extends RequestName>(
  name: Name,
  args: Requests[Name]["request"],
): Promise<Requests[Name]["result"]> {
  const envelope: Envelope<Name> = { blockSpam: name, args };
  const reply = (await browser.runtime.sendMessage(envelope)) as Reply<Requests[Name]["result"]> | undefined;
  if (reply === undefined) {
    throw new Error("The background page did not answer.");
  }
  if (!reply.ok) {
    throw new RequestError(reply.error, reply.code ?? "");
  }
  return reply.result;
}

export const COMPANION_ID = "block-spam-keys@thunderbird-block-spam";
export const KEY_PENDING_SIGN_IN = "pendingSignIn";
