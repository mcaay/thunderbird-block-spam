// The background page: a non-persistent event page. Every listener is registered at
// the top level, nothing depends on in-memory state surviving, and every job can
// restart from stored state. It is the only writer of storage.

import { createAi } from "./ai";
import type { Ai } from "./ai";
import { CHATGPT_RESPONSES_URL } from "./ai/chatgpt";
import {
  beginSignIn,
  completeSignIn,
  isCallbackUrl,
  revokeSession,
  SIGN_IN_TIMEOUT_MS,
  signedOut,
  SignInError,
} from "./ai/chatgptAuth";
import type { PendingSignIn } from "./ai/chatgptAuth";
import { isLoopbackHost, validateEndpoint } from "./ai/http";
import { checkDefinition, checkImportedDefinition, KEY_REQUIRED_TYPES, newAccessPoint, normalizeDefinition } from "./ai/presets";
import { isCommandName } from "./core/commands";
import type { CommandName } from "./core/commands";
import { errorText } from "./core/decision";
import { applySettingsPatch, manualEntry } from "./core/edit";
import { Engine } from "./core/engine";
import type { CommandOutcome, ScanProgress } from "./core/engine";
import { applyImport, buildExport } from "./core/exportImport";
import { KEY_ACCESS_POINTS } from "./core/keys";
import { folderKey } from "./core/ports";
import { SerialQueue } from "./core/queue";
import { AppState } from "./core/state";
import type { AccessPoint, ChatGptAuth } from "./core/types";
import { BUNDLED_PUBLIC_DOMAINS } from "./data/publicDomains";
import { t, tCode } from "./tb/i18n";
import { hold, withKeepAlive } from "./tb/keepAlive";
import { messagePages, messagesOfTab, ThunderbirdMail } from "./tb/mail";
import { COMPANION_ID, KEY_PENDING_SIGN_IN } from "./tb/protocol";
import type { Envelope, Reply, RequestName, Requests, Status } from "./tb/protocol";
import { BrowserStore } from "./tb/store";

const TICK_ALARM = "tick";
const TICK_MINUTES = 5;
const NOTIFICATION_TARGETS = 5;
/** "Score selected messages" sends at most this many messages in one run, also from listed senders. */
const SCORE_SELECTED_LIMIT = 50;

interface App {
  state: AppState;
  engine: Engine;
  ai: Ai;
}

type StoredSignIn = PendingSignIn & { url: string };

const store = new BrowserStore();
const mail = new ThunderbirdMail();
const queue = new SerialQueue();
const httpFetch = (url: string, init?: RequestInit): Promise<Response> => fetch(url, init);

let app: App | null = null;
/** Set when stored data failed validation: protection stays off and nothing is written. */
let fatal: string | null = null;
let scan: { progress: ScanProgress; cancelled: boolean } | null = null;
let scoring = false;
let signIn: StoredSignIn | null = null;
let signInError = "";
let releaseSignInHold: (() => void) | null = null;
let signInTimer: ReturnType<typeof setTimeout> | null = null;

let ready = start();

async function start(): Promise<void> {
  try {
    const raw = await store.all();
    const state = await AppState.load(raw, store, BUNDLED_PUBLIC_DOMAINS, Date.now());
    const ai = createAi({
      fetch: httpFetch,
      now: Date.now,
      persist: () => state.saveAccessPoints(),
      hasHostPermission: (pattern) => browser.permissions.contains({ origins: [pattern] }),
    });
    const engine = new Engine({
      state,
      mail,
      ai,
      now: Date.now,
      warn: (message, error) => console.warn(`Block Spam: ${message}`, error ?? ""),
    });
    app = { state, engine, ai };
    fatal = null;
    const pending = raw[KEY_PENDING_SIGN_IN] as StoredSignIn | undefined;
    signIn =
      pending !== undefined && typeof pending.startedAt === "number" && Date.now() - pending.startedAt < SIGN_IN_TIMEOUT_MS
        ? pending
        : null;
    if (signIn !== null) {
      watchSignIn(signIn);
    } else if (pending !== undefined) {
      await store.remove([KEY_PENDING_SIGN_IN]);
    }
  } catch (error) {
    app = null;
    fatal = errorText(error);
    console.error("Block Spam: stored data is not valid. Protection is off.", error);
  }
}

function need(): App {
  if (app === null) {
    throw new Error(fatal ?? t("errorNotReady"));
  }
  return app;
}

// ---------------------------------------------------------------------------
// Triggers: startup, the 5 minute alarm and new mail run the same idempotent job.

/** Set by Thunderbird's startup and by an installation or update: the next tick also sweeps the screening folders. */
let sweepOnTick = false;

function requestTick(startup = false): void {
  if (startup) {
    sweepOnTick = true;
  }
  queue.add(
    () =>
      withKeepAlive(async () => {
        await ready;
        if (app === null) {
          return;
        }
        mail.resetCache();
        // Read when the tick runs, so a tick that was already waiting picks it up too.
        const sweep = sweepOnTick;
        sweepOnTick = false;
        await app.engine.tick({ sweep });
      }),
    "tick",
  );
}

async function ensureAlarm(): Promise<void> {
  if ((await browser.alarms.get(TICK_ALARM)) === undefined) {
    await browser.alarms.create(TICK_ALARM, { periodInMinutes: TICK_MINUTES });
  }
}

browser.runtime.onStartup.addListener(() => requestTick(true));

browser.runtime.onInstalled.addListener((details) => {
  requestTick(true);
  if (details.reason === "install") {
    void browser.runtime.openOptionsPage().catch(() => undefined);
  }
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) {
    requestTick();
  }
});

browser.messages.onNewMailReceived.addListener((folder, list) => {
  const accountId = folder.accountId;
  if (accountId === undefined) {
    return;
  }
  queue.add(() =>
    withKeepAlive(async () => {
      await ready;
      if (app === null) {
        return;
      }
      mail.resetCache();
      await app.engine.handleNewMail({ accountId, path: folder.path }, messagePages(list));
    }),
  );
});

void ensureAlarm().catch((error) => console.error("Block Spam: the alarm could not be created", error));

// ---------------------------------------------------------------------------
// Live send: teaches the recipients immediately.

function recipientStrings(value: tb.ComposeRecipient | tb.ComposeRecipient[] | undefined): string[] {
  const list = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return list.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

browser.compose.onAfterSend.addListener((_tab, sendInfo) => {
  void (async () => {
    if (sendInfo.error !== undefined && sendInfo.error !== "") {
      return;
    }
    await ready;
    const details = sendInfo.details;
    if (app === null || details === undefined) {
      return;
    }
    const recipients = [...recipientStrings(details.to), ...recipientStrings(details.cc), ...recipientStrings(details.bcc)];
    if (recipients.length === 0) {
      return;
    }
    let accountId: string | null = null;
    if (details.identityId !== undefined) {
      accountId = (await browser.identities.get(details.identityId))?.accountId ?? null;
    }
    accountId ??= sendInfo.messages?.[0]?.folder?.accountId ?? null;
    if (accountId === null) {
      return; // the Sent folder watch learns this message on the next tick
    }
    const engine = app.engine;
    const account = accountId;
    mail.resetCache();
    await withKeepAlive(() => engine.learnFromSend(account, recipients));
  })().catch((error) => console.warn("Block Spam: learning from a sent message failed", error));
});

// ---------------------------------------------------------------------------
// Shortcuts. The optional companion add-on sends the same four command names.

function listTargets(outcome: CommandOutcome): string {
  const values = outcome.plan.targets.map((target) => target.value);
  const shown = values.slice(0, NOTIFICATION_TARGETS).join(", ");
  return values.length > NOTIFICATION_TARGETS ? t("notifyMore", shown, values.length - NOTIFICATION_TARGETS) : shown;
}

async function notifyCommand(outcome: CommandOutcome): Promise<void> {
  const { plan } = outcome;
  const lines: string[] = [];
  if (plan.targets.length > 0) {
    lines.push(t(plan.list === "black" ? "notifyBlocked" : "notifyTrusted", listTargets(outcome)));
  }
  if (plan.unknownSenders > 0) {
    lines.push(t("notifyUnknownSender", plan.unknownSenders));
  }
  if (outcome.moved > 0) {
    lines.push(t(plan.list === "black" ? "notifyMovedToJunk" : "notifyMovedToInbox", outcome.moved));
  }
  if (plan.ignoredOwn > 0) {
    lines.push(t("notifyOwnIgnored", plan.ignoredOwn));
  }
  const failure = outcome.failures[0];
  if (failure !== undefined) {
    const text =
      failure === "no-junk-folder" ? tCode("reason", failure) : failure === "no-inbox-folder" ? t("notifyNoInbox") : failure;
    lines.push(t("notifyMoveFailed", text));
  }
  if (lines.length === 0) {
    lines.push(t("notifyNothingChanged"));
  }
  await browser.notifications.create({
    type: "basic",
    title: t("extensionName"),
    message: lines.join("\n"),
    iconUrl: browser.runtime.getURL("icons/icon.svg"),
  });
}

async function runCommand(command: CommandName, tab: tb.Tab | undefined): Promise<void> {
  await ready;
  if (app === null) {
    return;
  }
  const messages = await messagesOfTab(tab);
  if (messages.length === 0) {
    return;
  }
  const engine = app.engine;
  mail.resetCache();
  const outcome = await withKeepAlive(() => engine.runCommand(command, messages));
  await notifyCommand(outcome);
}

browser.commands.onCommand.addListener((command, tab) => {
  if (isCommandName(command)) {
    void runCommand(command, tab).catch((error) => console.error("Block Spam: the shortcut failed", error));
  }
});

browser.runtime.onMessageExternal.addListener((message, sender) => {
  // Only the companion add-on is accepted, and only the four command names.
  const command = (message as { command?: unknown } | null)?.command;
  if (sender.id !== COMPANION_ID || !isCommandName(command)) {
    return undefined;
  }
  return (async () => {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    await runCommand(command, tab);
    return { ok: true };
  })();
});

// ---------------------------------------------------------------------------
// ChatGPT plan sign-in: the add-on cannot listen on a port, so it reads the address
// of the navigation to the loopback callback. Pasting the address is the fallback.

async function clearSignIn(closeTab: boolean): Promise<void> {
  const tabId = signIn?.tabId ?? null;
  signIn = null;
  if (signInTimer !== null) {
    clearTimeout(signInTimer);
    signInTimer = null;
  }
  releaseSignInHold?.();
  releaseSignInHold = null;
  await store.remove([KEY_PENDING_SIGN_IN]);
  if (closeTab && tabId !== null) {
    await browser.tabs.remove(tabId).catch(() => undefined);
  }
}

/** Keeps the page awake while a sign-in is pending and drops the attempt when it times out. */
function watchSignIn(pending: StoredSignIn): void {
  releaseSignInHold?.();
  releaseSignInHold = hold();
  if (signInTimer !== null) {
    clearTimeout(signInTimer);
  }
  signInTimer = setTimeout(
    () => {
      if (signIn?.state === pending.state) {
        signInError = t("signInTimedOut");
        void clearSignIn(false);
      }
    },
    Math.max(0, pending.startedAt + SIGN_IN_TIMEOUT_MS - Date.now()),
  );
}

/** The attempt whose code is being exchanged. A second callback for it waits for the first. */
let completing: { state: string; done: Promise<void> } | null = null;

async function finishSignIn(callbackUrl: string): Promise<void> {
  need();
  const pending = signIn;
  if (pending === null) {
    throw new Error(t("signInNoneInProgress"));
  }
  // The capture and a pasted address can both arrive: a code is exchanged only once.
  if (completing?.state === pending.state) {
    return completing.done;
  }
  const done = completeAttempt(pending, callbackUrl);
  completing = { state: pending.state, done };
  try {
    await done;
  } finally {
    if (completing?.done === done) {
      completing = null;
    }
  }
}

async function completeAttempt(pending: StoredSignIn, callbackUrl: string): Promise<void> {
  const { state, ai } = need();
  /** False once the attempt was cancelled, timed out or replaced by a new one. */
  const current = (): boolean => signIn?.state === pending.state;
  try {
    const auth = await withKeepAlive(() => completeSignIn(httpFetch, callbackUrl, pending, Date.now()));
    if (!current()) {
      // The user cancelled or started again while the code was exchanged: end the new session.
      await revoke(auth).catch(() => false);
      return;
    }
    // The attempt is complete. Ending it now (signIn is cleared at once) means that a
    // sign-in started from here on is never touched by this one.
    signInError = "";
    const ended = clearSignIn(true);
    ended.catch(() => undefined); // awaited below; this only keeps an early failure from going unhandled
    let point = pending.accessPointId === null ? undefined : state.accessPoints.find((item) => item.id === pending.accessPointId);
    if (point === undefined) {
      point = newAccessPoint(
        crypto.randomUUID(),
        {
          type: "chatgpt",
          name: auth.email === "" ? t("chatgptDefaultName") : t("chatgptNamedAccount", auth.email),
          enabled: true,
          endpoint: CHATGPT_RESPONSES_URL,
          model: "",
        },
        "",
      );
      state.accessPoints.push(point);
    }
    point.auth = auth;
    point.needsAttention = false;
    point.cooldownUntil = 0;
    point.lastError = "";
    await state.saveAccessPoints();
    await ended;
    if (point.model === "") {
      // The user picks the model later. Start with the first one the account offers.
      try {
        const first = (await ai.listModels(point))[0];
        if (first !== undefined) {
          point.model = first.id;
          await state.saveAccessPoints();
        }
      } catch (error) {
        console.warn("Block Spam: the model list could not be loaded", error);
      }
    }
  } catch (error) {
    const message = error instanceof SignInError ? tCode("signInError", error.code, error.detail) : errorText(error);
    if (current()) {
      signInError = message;
      // A wrong pasted address can be corrected. Any other failure ends the attempt.
      const retryable = error instanceof SignInError && ["wrong-address", "state-mismatch", "no-code"].includes(error.code);
      if (!retryable) {
        await clearSignIn(true);
      }
    }
    throw new Error(message);
  }
}

function onLoopbackRequest(details: { url: string }): void {
  void (async () => {
    await ready;
    if (signIn !== null && isCallbackUrl(details.url, signIn)) {
      await finishSignIn(details.url);
    }
  })().catch((error) => console.warn("Block Spam: sign-in failed", error));
}

/** Registers the redirect listener once the optional webRequest permission is present. */
function ensureRedirectListener(): void {
  const api = browser.webRequest;
  if (api !== undefined && !api.onBeforeRequest.hasListener(onLoopbackRequest)) {
    api.onBeforeRequest.addListener(onLoopbackRequest, { urls: ["http://127.0.0.1/*"], types: ["main_frame"] });
  }
}

ensureRedirectListener();
browser.permissions.onAdded.addListener(() => ensureRedirectListener());

async function revoke(auth: ChatGptAuth | null): Promise<boolean> {
  return auth === null ? true : withKeepAlive(() => revokeSession(httpFetch, auth));
}

/** The sign-ins in stored data, read leniently: Reset runs when the data may be invalid. */
function storedSessions(raw: Record<string, unknown>): ChatGptAuth[] {
  const points = raw[KEY_ACCESS_POINTS];
  const sessions: ChatGptAuth[] = [];
  for (const point of Array.isArray(points) ? points : []) {
    const auth: unknown = typeof point === "object" && point !== null ? (point as { auth?: unknown }).auth : null;
    if (typeof auth !== "object" || auth === null) {
      continue;
    }
    const { refreshToken, clientId } = auth as { refreshToken?: unknown; clientId?: unknown };
    if (typeof refreshToken === "string" && refreshToken !== "" && typeof clientId === "string") {
      sessions.push(auth as ChatGptAuth);
    }
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Requests from the settings page and the popup.

function findPoint(state: AppState, id: string): AccessPoint {
  const point = state.accessPoints.find((item) => item.id === id);
  if (point === undefined) {
    throw new Error(t("errorAccessPointGone"));
  }
  return point;
}

type Handlers = {
  [Name in RequestName]: (
    args: Requests[Name]["request"],
    sender: tb.MessageSender,
  ) => Promise<Requests[Name]["result"]>;
};

const handlers: Handlers = {
  async getStatus(): Promise<Status> {
    return {
      fatal,
      scan: scan?.progress ?? null,
      signIn: { url: signIn?.url ?? null, error: signInError, capture: browser.webRequest !== undefined },
      scoring,
    };
  },

  async setProtection({ on }) {
    const { state } = need();
    state.settings.protection = on === true;
    if (state.settings.protection) {
      state.settings.protectionOnAt = Date.now();
    }
    await state.saveSettings();
    if (state.settings.protection) {
      requestTick();
    }
    return null;
  },

  async updateSettings({ patch }) {
    const { state } = need();
    const { settings, invalid } = applySettingsPatch(state.settings, patch);
    state.settings = settings;
    await state.saveSettings();
    return { invalid };
  },

  async addEntry(args) {
    const { state, engine } = need();
    const accounts = await mail.accounts();
    const entry = manualEntry(
      args,
      accounts.map((account) => account.id),
    );
    const result = state.addEntry(entry, Date.now());
    await state.saveEntries();
    mail.resetCache();
    await withKeepAlive(() => engine.sweepIfNeeded());
    return { value: entry.value, result };
  },

  async removeEntries({ keys }) {
    const { state } = need();
    let removed = 0;
    for (const key of keys) {
      if (state.removeEntry(key)) {
        removed += 1;
      }
    }
    await state.saveEntries();
    return { removed };
  },

  async startScan({ from, to }) {
    const { engine } = need();
    if (scan?.progress.running === true) {
      throw new Error(t("errorScanRunning"));
    }
    const current = {
      cancelled: false,
      progress: { running: true, cancelled: false, folderIndex: 0, folderCount: 0, folder: null, scanned: 0, added: 0, errors: [] } as ScanProgress,
    };
    scan = current;
    mail.resetCache();
    void withKeepAlive(async () => {
      try {
        current.progress = await engine.scan(
          { from, to },
          (progress) => {
            current.progress = progress;
          },
          () => current.cancelled,
        );
      } catch (error) {
        current.progress = { ...current.progress, running: false, errors: [...current.progress.errors, errorText(error)] };
      }
    });
    return null;
  },

  async cancelScan() {
    if (scan !== null) {
      scan.cancelled = true;
    }
    return null;
  },

  async createScreeningFolder({ accountId }) {
    const { state } = need();
    const folderName = t("screeningFolderName");
    const folders = await browser.folders.query({ accountId });
    let folder = folders.find((item) => item.path === `/${folderName}`);
    if (folder === undefined) {
      const create = browser.folders.create;
      if (typeof create !== "function") {
        throw new Error(t("errorFolderPermission"));
      }
      const account = await browser.accounts.get(accountId);
      if (account === null) {
        throw new Error(t("errorAccountGone"));
      }
      try {
        folder = await create(account.rootFolder.id, folderName);
      } catch (error) {
        // Some servers only allow folders below the Inbox.
        const inbox = (await browser.folders.query({ accountId, specialUse: ["inbox"] }))[0];
        if (inbox === undefined) {
          throw error;
        }
        folder = await create(inbox.id, folderName);
      }
    }
    state.settings.screeningFolders = [
      ...state.settings.screeningFolders.filter((item) => item.accountId !== accountId),
      { accountId, path: folder.path },
    ];
    await state.saveSettings();
    mail.resetCache();
    return { path: folder.path };
  },

  async saveAccessPoint({ id, definition: raw, apiKey: newKey }) {
    const { state } = need();
    const definition = normalizeDefinition(raw);
    const existing = id === null ? null : findPoint(state, id);
    if (existing !== null && existing.type !== definition.type) {
      throw new Error(t("errorTypeChange"));
    }
    if (existing === null && definition.type === "chatgpt") {
      throw new Error(t("errorChatgptNeedsSignIn"));
    }
    const apiKey = (newKey ?? existing?.apiKey ?? "").trim();
    const problems = checkDefinition(definition, apiKey !== "");
    if (problems.length > 0) {
      throw new Error(problems.map((problem) => tCode("problem", problem)).join(" "));
    }
    if (existing === null) {
      const point = newAccessPoint(crypto.randomUUID(), definition, apiKey);
      state.accessPoints.push(point);
      await state.saveAccessPoints();
      return { id: point.id };
    }
    // Editing an access point clears "needs attention" and the cool-down.
    Object.assign(existing, definition, { apiKey, needsAttention: false, cooldownUntil: 0, lastError: "" });
    await state.saveAccessPoints();
    return { id: existing.id };
  },

  async removeAccessPoint({ id }) {
    const { state } = need();
    const point = findPoint(state, id);
    // Cleared before revoking, so that a token refresh still running is not installed.
    const auth = point.auth;
    point.auth = null;
    state.accessPoints = state.accessPoints.filter((item) => item.id !== id);
    await state.saveAccessPoints();
    const revocationConfirmed = await revoke(auth);
    return { revocationConfirmed };
  },

  async moveAccessPoint({ id, direction }) {
    const { state } = need();
    const index = state.accessPoints.findIndex((item) => item.id === id);
    const target = index + (direction < 0 ? -1 : 1);
    const moving = state.accessPoints[index];
    const other = state.accessPoints[target];
    if (moving !== undefined && other !== undefined) {
      state.accessPoints[index] = other;
      state.accessPoints[target] = moving;
      await state.saveAccessPoints();
    }
    return null;
  },

  async testAccessPoint({ id }) {
    const { state, engine } = need();
    const point = findPoint(state, id);
    return withKeepAlive(() => engine.testAccessPoint(point));
  },

  async listModels({ id }) {
    const { state, ai } = need();
    const point = findPoint(state, id);
    return withKeepAlive(() => ai.listModels(point));
  },

  async startSignIn({ accessPointId, openTab }, sender) {
    const { state } = need();
    const point = accessPointId === null ? null : findPoint(state, accessPointId);
    if (point !== null && point.type !== "chatgpt") {
      throw new Error(t("errorAccessPointGone"));
    }
    if (signIn !== null) {
      await clearSignIn(true);
    }
    const auth = point?.auth ?? null;
    const { url, pending } = await beginSignIn({
      hostId: state.hostId,
      returning: auth === null ? null : { clientId: auth.clientId, subject: auth.subject, email: auth.email, idToken: auth.idToken },
      accessPointId,
      now: Date.now(),
    });
    if (openTab) {
      try {
        const windowId = sender.tab?.windowId;
        // "relaxed" keeps the whole sign-in, including the redirect, inside the tab.
        const tab = await browser.tabs.create(
          windowId === undefined ? { url, linkHandler: "relaxed" } : { url, windowId, linkHandler: "relaxed" },
        );
        pending.tabId = tab.id ?? null;
      } catch (error) {
        console.warn("Block Spam: the sign-in tab could not be opened", error);
      }
    }
    signIn = { ...pending, url };
    signInError = "";
    await store.set({ [KEY_PENDING_SIGN_IN]: signIn });
    ensureRedirectListener();
    watchSignIn(signIn);
    return { url };
  },

  async finishSignIn({ url }) {
    await finishSignIn(url);
    return null;
  },

  async cancelSignIn() {
    signInError = "";
    await clearSignIn(true);
    return null;
  },

  async signOut({ id }) {
    const { state } = need();
    const point = findPoint(state, id);
    // Cleared before revoking, so that a token refresh still running is not installed.
    const auth = point.auth;
    if (auth !== null) {
      point.auth = signedOut(auth);
    }
    point.needsAttention = true;
    point.lastError = "";
    await state.saveAccessPoints();
    const revocationConfirmed = await revoke(auth);
    return { revocationConfirmed };
  },

  async clearLog() {
    await need().state.clearLog();
    return null;
  },

  async exportData() {
    const { state } = need();
    return buildExport(state, await mail.accounts(), Date.now());
  },

  async importData({ file, mode }) {
    const { state, engine } = need();
    const accounts = await mail.accounts();
    const folders = new Set<string>();
    for (const account of accounts) {
      for (const folder of await browser.folders.query({ accountId: account.id })) {
        folders.add(folderKey({ accountId: account.id, path: folder.path }));
      }
    }
    const previous = [...state.accessPoints];
    const report = applyImport(state, file, mode === "replace" ? "replace" : "merge", {
      accounts,
      folders,
      newId: () => crypto.randomUUID(),
      checkAccessPoint: checkImportedDefinition,
      needsSecret: (definition) => {
        const endpoint = validateEndpoint(definition.endpoint);
        return (
          definition.type === "chatgpt" ||
          KEY_REQUIRED_TYPES.includes(definition.type) ||
          !(endpoint.ok && isLoopbackHost(endpoint.url.hostname))
        );
      },
    });
    state.whiteAdded = true;
    await state.saveSettings();
    await state.saveEntries();
    await state.saveAccessPoints();
    if (report.mode === "replace") {
      // The replaced ChatGPT sign-ins are gone: end their sessions. Their tokens are
      // cleared first, so that a token refresh still running is not installed.
      const sessions = previous.map((point) => point.auth);
      for (const point of previous) {
        point.auth = null;
      }
      await Promise.all(sessions.map((auth) => revoke(auth).catch(() => false)));
    }
    mail.resetCache();
    await withKeepAlive(() => engine.sweepIfNeeded());
    return report;
  },

  async resetData() {
    if (scan !== null) {
      scan.cancelled = true;
    }
    // Let running jobs finish first, so that nothing is written after the reset.
    await queue.idle();
    scan = null;
    signInError = "";
    await clearSignIn(true);
    // The tokens are about to be forgotten, and the raw data the page offers to download
    // contains them: end those sessions first, as signing out and removing do.
    await Promise.all(storedSessions(await store.all()).map((auth) => revoke(auth).catch(() => false)));
    await store.clear();
    ready = start();
    await ready;
    requestTick();
    return null;
  },

  async selectedCount({ tabId }) {
    const messages = await messagesOfTab(await browser.tabs.get(tabId), SCORE_SELECTED_LIMIT);
    return { count: Math.min(messages.length, SCORE_SELECTED_LIMIT + 1), limit: SCORE_SELECTED_LIMIT };
  },

  async scoreSelected({ tabId }) {
    const { engine } = need();
    if (scoring) {
      throw new Error(t("errorScoringRunning"));
    }
    const messages = await messagesOfTab(await browser.tabs.get(tabId), SCORE_SELECTED_LIMIT);
    if (messages.length === 0) {
      return { selected: 0, scored: 0, failed: 0 };
    }
    if (messages.length > SCORE_SELECTED_LIMIT) {
      throw new Error(t("popupScoreTooMany", SCORE_SELECTED_LIMIT));
    }
    scoring = true;
    try {
      mail.resetCache();
      const summary = await withKeepAlive(() => engine.scoreSelected(messages));
      return { selected: messages.length, ...summary };
    } finally {
      scoring = false;
    }
  },

  async welcomeShown() {
    const { state } = need();
    state.settings.chatgptWelcomeShown = true;
    await state.saveSettings();
    return null;
  },
};

/** Requests that still work when stored data is invalid. */
const ALWAYS_ALLOWED: readonly RequestName[] = ["getStatus", "resetData"];

function isEnvelope(message: unknown): message is Envelope {
  return (
    typeof message === "object" &&
    message !== null &&
    typeof (message as Envelope).blockSpam === "string" &&
    Object.hasOwn(handlers, (message as Envelope).blockSpam)
  );
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!isEnvelope(message)) {
    return undefined;
  }
  // Only this add-on's own pages may send requests.
  if (sender.id !== undefined && sender.id !== browser.runtime.id) {
    return undefined;
  }
  return (async (): Promise<Reply<unknown>> => {
    try {
      await ready;
      if (fatal !== null && !ALWAYS_ALLOWED.includes(message.blockSpam)) {
        throw new Error(fatal);
      }
      const handler = handlers[message.blockSpam] as (args: unknown, sender: tb.MessageSender) => Promise<unknown>;
      return { ok: true, result: await handler(message.args ?? {}, sender) };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  })();
});
