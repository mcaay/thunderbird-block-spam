// A complete engine wired to fakes, for tests of the pipeline.

import { AccessPointError } from "../../src/core/chain";
import { Engine } from "../../src/core/engine";
import { logChunkKey } from "../../src/core/log";
import type { AiPort } from "../../src/core/ports";
import type { AppState } from "../../src/core/state";
import type { AccessPoint, FolderRef, LogEntry } from "../../src/core/types";
import { FakeMail, makeState, MemoryStore, NOW } from "./fakes";

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export const INBOX1: FolderRef = { accountId: "account1", path: "/INBOX" };
export const SENT1: FolderRef = { accountId: "account1", path: "/Sent" };
export const JUNK1: FolderRef = { accountId: "account1", path: "/Junk" };
export const INBOX2: FolderRef = { accountId: "account2", path: "/INBOX" };
export const SENT2: FolderRef = { accountId: "account2", path: "/Sent" };
export const JUNK2: FolderRef = { accountId: "account2", path: "/Junk" };
export const SCREEN1: FolderRef = { accountId: "account1", path: "/Screening" };

export type Reply = number | Error | ((point: AccessPoint, payload: string) => number | Promise<number>);

export class FakeAi implements AiPort {
  calls: { point: string; prompt: string; payload: string }[] = [];
  /** Reply per access point id. "*" is the default. */
  replies: Record<string, Reply> = { "*": 0.5 };

  async score(point: AccessPoint, prompt: string, payload: string): Promise<number> {
    this.calls.push({ point: point.id, prompt, payload });
    const reply = this.replies[point.id] ?? this.replies["*"] ?? 0.5;
    if (reply instanceof Error) {
      throw reply;
    }
    return typeof reply === "function" ? reply(point, payload) : reply;
  }
}

export function accessPoint(partial: Partial<AccessPoint> = {}): AccessPoint {
  return {
    id: "ap1",
    type: "openai-chat",
    name: "Primary",
    enabled: true,
    endpoint: "https://api.example.com/v1",
    model: "model-1",
    apiKey: "secret-key",
    auth: null,
    cooldownUntil: 0,
    needsAttention: false,
    lastError: "",
    ...partial,
  };
}

export const quota = (retryAfterMs: number | null = null): AccessPointError =>
  new AccessPointError("quota", "HTTP 429", retryAfterMs);
export const unauthorized = (): AccessPointError => new AccessPointError("auth", "HTTP 401");
export const transient = (): AccessPointError => new AccessPointError("transient", "HTTP 500");

export interface Harness {
  mail: FakeMail;
  state: AppState;
  store: MemoryStore;
  ai: FakeAi;
  engine: Engine;
  warnings: string[];
  clock: { now: number };
  /** All log entries stored so far, oldest first. */
  log(): LogEntry[];
  /** Switches protection on at the current time, as the settings page does. */
  protect(): void;
}

/**
 * Two accounts: account1 "Work" (me@mycompany.example, a custom domain) and
 * account2 "Private" (me@gmail.com). Protection is off, as after installation.
 */
export async function harness(raw: Record<string, unknown> = {}): Promise<Harness> {
  const mail = new FakeMail()
    .addAccount("account1", "me@mycompany.example", "Work")
    .addAccount("account2", "me@gmail.com", "Private");
  const { state, store } = await makeState(raw);
  const ai = new FakeAi();
  const warnings: string[] = [];
  const clock = { now: NOW };
  const engine = new Engine({
    state,
    mail,
    ai,
    now: () => clock.now,
    warn: (message) => warnings.push(message),
  });
  return {
    mail,
    state,
    store,
    ai,
    engine,
    warnings,
    clock,
    log() {
      const meta = (store.data.logMeta ?? { first: 0, last: 0 }) as { first: number; last: number };
      const entries: LogEntry[] = [];
      for (let index = meta.first; index <= meta.last; index += 1) {
        entries.push(...((store.data[logChunkKey(index)] ?? []) as LogEntry[]));
      }
      return entries;
    },
    protect() {
      state.settings.protection = true;
      state.settings.protectionOnAt = clock.now;
    },
  };
}
