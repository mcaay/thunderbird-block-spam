// Messages between the settings page, the popup and the background page. The pages
// never write storage: every change is a request to the background.

import type { AccessPointDefinition } from "../ai/presets";
import type { ModelOption } from "../ai/openaiChat";
import type { SettingsPatch } from "../core/edit";
import type { AccessPointTestResult, ScanProgress, TestScoreSummary } from "../core/engine";
import type { ExportResult, ImportMode, ImportReport } from "../core/exportImport";

export interface Requests {
  getStatus: { request: Record<string, never>; result: Status };
  setProtection: { request: { on: boolean }; result: null };
  updateSettings: { request: { patch: SettingsPatch }; result: { invalid: string[] } };
  addEntry: {
    request: { list: string; kind: string; value: string; scope: string };
    result: { value: string; result: string };
  };
  removeEntries: { request: { keys: string[] }; result: { removed: number } };
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
  startSignIn: { request: { accessPointId: string | null; openTab: boolean }; result: { url: string } };
  finishSignIn: { request: { url: string }; result: null };
  cancelSignIn: { request: Record<string, never>; result: null };
  signOut: { request: { id: string }; result: { revocationConfirmed: boolean } };
  clearLog: { request: Record<string, never>; result: null };
  exportData: { request: Record<string, never>; result: ExportResult };
  importData: { request: { file: unknown; mode: ImportMode }; result: ImportReport };
  resetData: { request: Record<string, never>; result: null };
  scoreSelected: { request: { tabId: number }; result: TestScoreSummary & { selected: number } };
  welcomeShown: { request: Record<string, never>; result: null };
}

export type RequestName = keyof Requests;

export interface Envelope<Name extends RequestName = RequestName> {
  blockSpam: Name;
  args: Requests[Name]["request"];
}

export type Reply<Result> = { ok: true; result: Result } | { ok: false; error: string };

export interface SignInStatus {
  /** The authorization address of the attempt in progress, or null. */
  url: string | null;
  /** Why the last attempt failed, or "". */
  error: string;
  /** The redirect could be captured automatically (the webRequest permission is present). */
  capture: boolean;
}

export interface Status {
  /** Set when stored data failed validation. Protection is off and nothing is written. */
  fatal: string | null;
  scan: ScanProgress | null;
  signIn: SignInStatus;
  /** A test of selected messages is running. */
  scoring: boolean;
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
    throw new Error(reply.error);
  }
  return reply.result;
}

export const COMPANION_ID = "block-spam-keys@thunderbird-block-spam";
export const KEY_PENDING_SIGN_IN = "pendingSignIn";
