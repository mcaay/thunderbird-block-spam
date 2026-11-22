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
import { checkDefinition, checkImportedDefinition, KEY_REQUIRED_TYPES, newAccessPoint, normalizeDefinition, requiredOrigins } from "./ai/presets";
import { COMMANDS, isCommandName } from "./core/commands";
import type { CommandName } from "./core/commands";
import { errorText } from "./core/decision";
import { applySettingsPatch, manualEntry } from "./core/edit";
import { chosenFolders, mayJoin, refusedFolders, screeningFolderPaths } from "./core/folders";
import type { FolderFacts } from "./core/folders";
import { Engine } from "./core/engine";
import type { CommandOutcome, CommandUndo, LogActionUndo, ScanProgress } from "./core/engine";
import { applyImport, buildExport } from "./core/exportImport";
import { KEY_ACCESS_POINTS, KEY_ATTENTION_NOTIFIED, KEY_LAST_COMMAND, KEY_LAST_IMPORT, KEY_PROTECTION_WISH, KEY_SETTINGS } from "./core/keys";
import { whiteListIsOnlyIdentities } from "./core/lists";
import { validateLogEntry } from "./core/log";
import { isLogAction } from "./core/logAction";
import { folderKey } from "./core/ports";
import { findProblems, protectionState, remedyFor, scanIsComplete } from "./core/problems";
import type { Remedy } from "./core/problems";
import { isNoWish, NO_WISH, outcomeOfScan, outcomeWithoutService, readWish, withoutService } from "./core/protectionWish";
import type { ProtectionWish } from "./core/protectionWish";
import { SerialQueue } from "./core/queue";
import { asArray, asBoolean, asNumber, asRecord, asString, invalidSettings, isSettingName, validateEntry, ValidationError, withDefaults } from "./core/settings";
import { AppState } from "./core/state";
import type { AccessPoint, ChatGptAuth, FolderRef, MessageInfo } from "./core/types";
import { BUNDLED_PUBLIC_DOMAINS } from "./data/publicDomains";
import { t, tCode, tn } from "./tb/i18n";
import { hold, withKeepAlive } from "./tb/keepAlive";
import { collect, messagePages, messagesOfTab, ThunderbirdMail } from "./tb/mail";
import { commandLines } from "./tb/commandText";
import { problemNames, servicesOutcomeText, wishOutcomeText } from "./tb/stateText";
import { COMPANION_ID, KEY_PENDING_SIGN_IN } from "./tb/protocol";
import type {
  CommandRecord,
  CommandSource,
  Envelope,
  PageEvent,
  Reply,
  RequestName,
  Requests,
  SettingsTarget,
  Status,
  StoredCommand,
} from "./tb/protocol";
import { BrowserStore } from "./tb/store";

const TICK_ALARM = "tick";
const TICK_MINUTES = 5;
/** "Score selected messages" sends at most this many messages in one run, also from listed senders. */
const SCORE_SELECTED_LIMIT = 50;

interface App {
  state: AppState;
  engine: Engine;
  ai: Ai;
}

/** `afterScan`: the answer to "scan first" for a new service. True waits for the scan, false uses the service anyway, null was not asked. */
type StoredSignIn = PendingSignIn & { url: string; afterScan?: boolean | null };

const store = new BrowserStore();
const mail = new ThunderbirdMail();
const queue = new SerialQueue();
const httpFetch = (url: string, init?: RequestInit): Promise<Response> => fetch(url, init);

let app: App | null = null;
/** Set when stored data failed validation: protection stays off and nothing is written. */
let fatal: string | null = null;
/** With invalid stored data: the settings that are all that is wrong, see Status.repair. */
let repair: string[] | null = null;
/** The manual scan of this session: its progress, the dates it is limited to, and whether Cancel was pressed. */
interface RunningScan {
  progress: ScanProgress;
  cancelled: boolean;
  range: { from: number | null; to: number | null };
}
let scan: RunningScan | null = null;
/** What waits for the scan, as stored: "switch protection on", and AI services to be switched on. See core/protectionWish. */
let wish: ProtectionWish = NO_WISH;
let scoring = false;
let signIn: StoredSignIn | null = null;
let signInError = "";
let releaseSignInHold: (() => void) | null = null;
let signInTimer: ReturnType<typeof setTimeout> | null = null;

let ready = start();

/**
 * The settings whose stored value is not valid, when everything else in storage is
 * valid: with those settings at their defaults the data loads. Nothing is written.
 */
async function repairableSettings(raw: Record<string, unknown>): Promise<string[] | null> {
  const names = invalidSettings(raw[KEY_SETTINGS]);
  if (names === null || names.length === 0) {
    return null;
  }
  try {
    const nowhere = { set: async () => undefined, remove: async () => undefined };
    await AppState.load({ ...raw, [KEY_SETTINGS]: withDefaults(raw[KEY_SETTINGS], names, Date.now()) }, nowhere, BUNDLED_PUBLIC_DOMAINS, Date.now());
    return names;
  } catch {
    return null;
  }
}

async function start(): Promise<void> {
  let raw: Record<string, unknown> | null = null;
  try {
    raw = await store.all();
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
    repair = null;
    wish = readWish(raw[KEY_PROTECTION_WISH]);
    if (wish.waiting !== null && state.settings.protection) {
      // Protection was switched on some other way since: there is nothing left to wait for.
      await saveWish({ ...wish, waiting: null });
    }
    if (wish.services !== null) {
      // A service that is gone or was switched on some other way since has nothing left to wait for.
      const ids = wish.services.ids.filter((id) => state.accessPoints.some((point) => point.id === id && !point.enabled));
      if (ids.length !== wish.services.ids.length) {
        await saveWish({ ...wish, services: ids.length === 0 ? null : { ...wish.services, ids } });
      }
    }
    const waitingFor = wish.waiting ?? wish.services;
    if (waitingFor !== null && scan?.progress.running !== true) {
      // Thunderbird was closed while the scan ran. The wish is kept, so the scan starts again and what waits follows it.
      beginScan(engine, waitingFor.from, waitingFor.to);
    }
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
    wish = NO_WISH;
    fatal = errorText(error);
    repair = raw === null ? null : await repairableSettings(raw);
    console.error("Block Spam: stored data is not valid. Protection is off.", error);
  }
  requestAttention("badge");
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
        requestAttention("loud");
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
      requestAttention("loud");
    }),
  );
});

void ensureAlarm().catch((error) => console.error("Block Spam: the alarm could not be created", error));

// ---------------------------------------------------------------------------
// Problems that change what happens to mail are visible without opening anything: a
// badge on the toolbar button while protection is on and something is wrong, and one
// desktop notification when an AI service first needs the user.

const BADGE_COLOR = "#f5c542";
const BADGE_TEXT_COLOR = "#15141a";
const ATTENTION_NOTIFICATION = "attention:";

/**
 * - badge: only the badge is brought in line, when the background page starts.
 * - silent: after a request of a page. A service that needs attention now is one the
 *   user is looking at already: it is remembered as announced without a notification.
 * - loud: after background work (a tick, new mail). A service that needs attention for
 *   the first time is announced.
 */
type AttentionMode = "badge" | "silent" | "loud";
const ATTENTION_ORDER: readonly AttentionMode[] = ["badge", "silent", "loud"];

let attentionWanted: AttentionMode | null = null;
let attentionRunning = false;

/** Brings the badge in line with the problems, after anything that can change them. */
function requestAttention(mode: AttentionMode): void {
  if (attentionWanted === null || ATTENTION_ORDER.indexOf(mode) > ATTENTION_ORDER.indexOf(attentionWanted)) {
    attentionWanted = mode;
  }
  if (attentionRunning) {
    return;
  }
  attentionRunning = true;
  void (async () => {
    try {
      while (attentionWanted !== null) {
        const wanted = attentionWanted;
        attentionWanted = null;
        await updateAttention(wanted);
      }
    } catch (error) {
      console.warn("Block Spam: the toolbar button could not be updated", error);
    } finally {
      attentionRunning = false;
    }
  })();
}

/** The toolbar button: a badge while something is wrong, and the state of protection as its tooltip. */
async function showButton(badge: boolean, title: string): Promise<void> {
  await browser.action.setBadgeText({ text: badge ? "!" : "" });
  if (badge) {
    await browser.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    await browser.action.setBadgeTextColor({ color: BADGE_TEXT_COLOR });
  }
  await browser.action.setTitle({ title });
}

async function hostGranted(point: AccessPoint): Promise<boolean> {
  const origins = requiredOrigins(point) ?? [];
  try {
    return origins.length === 0 || (await browser.permissions.contains({ origins }));
  } catch {
    return true;
  }
}

async function updateAttention(mode: AttentionMode): Promise<void> {
  if (app === null) {
    await showButton(fatal !== null, tCode("tooltip", fatal === null ? "off" : "invalid"));
    return;
  }
  const { state } = app;
  const settings = state.settings;
  const [accounts, inboxes, junk] = await Promise.all([mail.accounts(), mail.specialFolders("inbox"), mail.specialFolders("junk")]);
  const needing = state.accessPoints.filter((point) => point.enabled && point.needsAttention);
  const refused = new Set<string>();
  for (const point of needing) {
    if (!(await hostGranted(point))) {
      refused.add(point.id);
    }
  }
  // Problems change what happens to mail only while protection is on. Until then the settings page shows them, and the button stays quiet.
  const problems = settings.protection
    ? findProblems({
        settings,
        accessPoints: state.accessPoints,
        accounts: accounts.map((account) => ({
          id: account.id,
          inboxes: inboxes.filter((folder) => folder.accountId === account.id),
          hasJunk: junk.some((folder) => folder.accountId === account.id),
        })),
        onlyOwnAddresses: whiteListIsOnlyIdentities(state.entries) && !scanIsComplete(scan?.progress ?? null),
        hostGranted: (point) => !refused.has(point.id),
        now: Date.now(),
      })
    : [];
  const shown = protectionState({
    invalid: false,
    accounts: accounts.length,
    protection: settings.protection,
    observation: settings.observation,
    problems: problems.length,
    waiting: wish.waiting !== null,
  });
  await showButton(
    shown === "problems",
    shown === "problems" ? tn("badgeProblems", problems.length, problemNames(problems, state.accessPoints)) : tCode("tooltip", shown),
  );
  if (mode === "badge") {
    return;
  }
  const loud = mode === "loud";

  // One notification per cause, not repeated until the service has worked again.
  const stored = (await browser.storage.local.get(KEY_ATTENTION_NOTIFIED))[KEY_ATTENTION_NOTIFIED];
  const notified = new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
  let changed = false;
  for (const id of [...notified]) {
    if (!needing.some((point) => point.id === id)) {
      notified.delete(id);
      changed = true;
    }
  }
  /** The services that need attention for the first time, by what to do about them: one remedy is one notification. */
  const fresh = new Map<Remedy, AccessPoint[]>();
  for (const point of needing) {
    if (notified.has(point.id) || (loud && !settings.protection)) {
      continue;
    }
    notified.add(point.id);
    changed = true;
    const remedy = remedyFor(point, !refused.has(point.id));
    fresh.set(remedy, [...(fresh.get(remedy) ?? []), point]);
  }
  if (loud) {
    for (const [remedy, points] of fresh) {
      const [only] = points;
      const message =
        points.length === 1 && only !== undefined
          ? `${t("warnNeedsAttention", only.name)} ${tCode("remedy", remedy)}`
          : `${t("warnNeedsAttentionMany", points.map((point) => point.name).join(", "))} ${tCode("remedyMany", remedy)}`;
      await browser.notifications
        .create(`${ATTENTION_NOTIFICATION}${points.map((point) => point.id).join(",")}`, {
          type: "basic",
          title: t("extensionName"),
          message,
          iconUrl: browser.runtime.getURL("icons/icon.svg"),
        })
        .catch((error: unknown) => console.warn("Block Spam: the notification could not be shown", error));
    }
  }
  if (changed) {
    await store.set({ [KEY_ATTENTION_NOTIFIED]: [...notified] });
  }
}

/** Brings the settings page to the front, or opens it, showing what the target names. */
async function openSettingsAt(target: SettingsTarget): Promise<void> {
  settingsTarget = { target, at: Date.now() };
  const event: PageEvent = { blockSpamEvent: "show", target };
  void browser.runtime.sendMessage(event).catch(() => undefined);
  const address = browser.runtime.getURL("options/options.html");
  const open = (await browser.tabs.query({})).find((tab) => tab.url?.startsWith(address) === true);
  if (open?.id === undefined) {
    await browser.runtime.openOptionsPage();
    return;
  }
  // Opening the page again would load it anew, and text typed into it would be lost.
  await browser.tabs.update(open.id, { active: true });
  if (open.windowId !== undefined) {
    await browser.windows.update(open.windowId, { focused: true });
  }
}

// A click on the notification about a service leads to the warning with its fix, and one about protection to its switch.
browser.notifications.onClicked.addListener((id) => {
  if (id.startsWith(ATTENTION_NOTIFICATION) || id === WISH_NOTIFICATION) {
    void openSettingsAt({ pane: "overview", logKey: null }).catch((error: unknown) => console.warn("Block Spam: the settings could not be opened", error));
  }
});

// ---------------------------------------------------------------------------
// The manual scan of the sent mail, and protection that waits for it.

const WISH_NOTIFICATION = "protection-after-scan";

async function switchProtection(state: AppState, on: boolean): Promise<void> {
  state.settings.protection = on;
  if (on) {
    // The moment protection really goes on is the one that counts: mail that arrived before it is never touched.
    state.settings.protectionOnAt = Date.now();
  }
  await state.saveSettings();
  if (on) {
    requestTick();
  }
}

async function saveWish(next: ProtectionWish): Promise<void> {
  wish = next;
  if (isNoWish(next)) {
    await store.remove([KEY_PROTECTION_WISH]);
  } else {
    await store.set({ [KEY_PROTECTION_WISH]: next });
  }
}

/** True while the settings page is the tab in front: what it shows needs no notification. */
async function settingsInFront(): Promise<boolean> {
  const address = browser.runtime.getURL("options/options.html");
  const tabs = await browser.tabs.query({ active: true }).catch(() => []);
  return tabs.some((tab) => tab.active === true && tab.url?.startsWith(address) === true);
}

/** True while mail from people the user writes to could reach an AI service: nobody was learned and no scan ran to its end, or a scan is still running. */
function scanStillNeeded(state: AppState): boolean {
  return scan?.progress.running === true || (whiteListIsOnlyIdentities(state.entries) && !scanIsComplete(scan?.progress ?? null));
}

/** The dates of the running scan, for a wish that joins it. */
function runningRange(): { from: number | null; to: number | null } | null {
  return scan?.progress.running === true ? scan.range : null;
}

/**
 * An AI service is to be switched on when the scan has finished. The scan that is running is waited for, or else a
 * scan of everything is started. When nothing is left to wait for, the service is switched on at once.
 */
async function serviceAfterScan(state: AppState, engine: Engine, point: AccessPoint): Promise<void> {
  if (point.enabled) {
    return;
  }
  if (!scanStillNeeded(state)) {
    point.enabled = true;
    await state.saveAccessPoints();
    return;
  }
  const running = runningRange();
  const ids = [...new Set([...(wish.services?.ids ?? []), point.id])];
  // Stored before the scan starts: a scan of an empty mailbox can end at once.
  await saveWish({
    ...wish,
    services: { since: wish.services?.since ?? Date.now(), from: running?.from ?? wish.services?.from ?? null, to: running?.to ?? wish.services?.to ?? null, ids },
    servicesOutcome: outcomeWithoutService(wish.servicesOutcome, point.id),
  });
  if (running === null) {
    beginScan(engine, null, null);
  }
}

/**
 * A scan has ended while something waited for it: protection, AI services, or both. A scan that ran to its end
 * switches on what waited, also when it read no message. A cancelled scan and one that could not read a folder
 * drop the wish. Either way the outcome is kept for the page to say, and one notification covers everything.
 */
async function settleWish(ended: RunningScan): Promise<void> {
  if ((wish.waiting === null && wish.services === null) || app === null) {
    return;
  }
  const { state } = app;
  const outcome = outcomeOfScan(ended.progress, Date.now());
  const protectionWaited = wish.waiting !== null;
  const waited = (wish.services?.ids ?? []).map((id) => state.accessPoints.find((point) => point.id === id)).filter((point): point is AccessPoint => point !== undefined && !point.enabled);
  if (outcome.kind === "on") {
    if (waited.length > 0) {
      for (const point of waited) {
        point.enabled = true;
      }
      await state.saveAccessPoints();
    }
    if (protectionWaited) {
      await switchProtection(state, true);
    }
  }
  await saveWish({
    waiting: null,
    outcome: protectionWaited ? outcome : wish.outcome,
    services: null,
    servicesOutcome: waited.length > 0 ? { ...outcome, ids: waited.map((point) => point.id) } : wish.servicesOutcome,
  });
  // Cancel was pressed on the page, which says what follows. The other two ends can come while nobody looks.
  if (outcome.kind !== "cancelled" && (protectionWaited || waited.length > 0) && !(await settingsInFront())) {
    const lines = [
      ...(protectionWaited ? [wishOutcomeText(outcome)] : []),
      ...(waited.length > 0
        ? [
            servicesOutcomeText(
              outcome,
              waited.map((point) => point.name),
              // After the sentence about protection the scan is not announced a second time.
              protectionWaited,
            ),
          ]
        : []),
    ];
    await browser.notifications
      .create(WISH_NOTIFICATION, { type: "basic", title: t("extensionName"), message: lines.join(" "), iconUrl: browser.runtime.getURL("icons/icon.svg") })
      .catch((error: unknown) => console.warn("Block Spam: the notification could not be shown", error));
  }
}

function beginScan(engine: Engine, from: number | null, to: number | null): void {
  const current: RunningScan = {
    cancelled: false,
    range: { from, to },
    progress: { running: true, cancelled: false, folderIndex: 0, folderCount: 0, folder: null, scanned: 0, added: 0, errors: [], total: null },
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
    if (scan === current) {
      await settleWish(current).catch((error: unknown) => console.error("Block Spam: protection could not be switched on after the scan", error));
    }
    // A scan that ran to its end ends the warning about AI before the first scan.
    requestAttention("silent");
  });
}

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
// The four commands: shortcuts, the context menu of the message list, the buttons of
// the toolbar popup, and the optional companion add-on all run the same code.

async function notifyCommand(record: CommandRecord): Promise<void> {
  // The notification cannot carry a button on every platform: it says where Undo is.
  const lines = record.undoable ? [...record.lines, t("notifyUndoHint")] : record.lines;
  await browser.notifications.create({
    type: "basic",
    title: t("extensionName"),
    message: lines.join("\n"),
    iconUrl: browser.runtime.getURL("icons/icon.svg"),
  });
}

function asCommandUndo(value: unknown): CommandUndo {
  const record = asRecord(value, "undo");
  return {
    remove: asArray(record.remove, "undo.remove", asString),
    restore: asArray(record.restore, "undo.restore", validateEntry),
    moves: asArray(record.moves, "undo.moves", (item, path) => {
      const move = asRecord(item, path);
      return {
        accountId: asString(move.accountId, `${path}.accountId`),
        messageId: asString(move.messageId, `${path}.messageId`),
        from: asFolderRef(move.from, `${path}.from`),
        to: asFolderRef(move.to, `${path}.to`),
      };
    }),
  };
}

/** The last command as stored. Null when there is none, or when what is stored is not one. */
async function storedCommand(): Promise<StoredCommand | null> {
  const raw = (await browser.storage.local.get(KEY_LAST_COMMAND))[KEY_LAST_COMMAND];
  if (raw === undefined) {
    return null;
  }
  try {
    const record = asRecord(raw, "lastCommand");
    return {
      id: asString(record.id, "lastCommand.id"),
      time: asNumber(record.time, "lastCommand.time"),
      source: asString(record.source, "lastCommand.source") as CommandSource,
      lines: asArray(record.lines, "lastCommand.lines", asString),
      failed: asBoolean(record.failed, "lastCommand.failed"),
      undoable: true,
      undo: asCommandUndo(record.undo),
    };
  } catch {
    return null;
  }
}

function publicRecord(command: StoredCommand): CommandRecord {
  return { id: command.id, time: command.time, source: command.source, lines: command.lines, failed: command.failed, undoable: command.undoable };
}

/** Runs a command on the given messages. Null when there is nothing to act on. */
async function executeCommand(command: CommandName, messages: MessageInfo[]): Promise<CommandOutcome | null> {
  await ready;
  if (app === null || messages.length === 0) {
    return null;
  }
  const engine = app.engine;
  mail.resetCache();
  return withKeepAlive(() => engine.runCommand(command, messages));
}

/**
 * Runs a command and keeps what is needed to take it back: the popup offers Undo for
 * the last command that changed something, until it is undone, dismissed or replaced.
 * A command that changed nothing leaves the one before it in place.
 */
async function recordCommand(command: CommandName, messages: MessageInfo[], source: CommandSource): Promise<CommandRecord | null> {
  const outcome = await executeCommand(command, messages);
  if (outcome === null) {
    return null;
  }
  const { undo } = outcome;
  const record: CommandRecord = {
    id: crypto.randomUUID(),
    time: Date.now(),
    source,
    lines: commandLines(outcome),
    failed: outcome.failures.length > 0,
    undoable: undo.remove.length > 0 || undo.restore.length > 0 || undo.moves.length > 0,
  };
  if (record.undoable) {
    const stored: StoredCommand = { ...record, undo };
    await store.set({ [KEY_LAST_COMMAND]: stored });
  }
  requestAttention("silent");
  return record;
}

/** A command from a shortcut, the context menu or the companion: a desktop notification confirms it. */
async function runCommand(command: CommandName, messages: MessageInfo[], source: CommandSource): Promise<void> {
  const record = await recordCommand(command, messages, source);
  if (record !== null) {
    await notifyCommand(record);
  }
}

browser.commands.onCommand.addListener((command, tab) => {
  if (isCommandName(command)) {
    void (async () => runCommand(command, await messagesOfTab(tab), "shortcut"))().catch((error) =>
      console.error("Block Spam: the shortcut failed", error),
    );
  }
});

// The context menu of the message list: a "Block Spam" submenu with the four commands.

const MENU_ROOT = "block-spam-menu";
const MENU_SEPARATOR = "block-spam-separator";
const COMMAND_LABELS: Record<CommandName, string> = {
  "block-address": "cmdBlockAddress",
  "block-domain": "cmdBlockDomain",
  "trust-address": "cmdTrustAddress",
  "trust-domain": "cmdTrustDomain",
};

/**
 * Builds the menu each time the background page starts, so that it exists after an
 * installation, an update and a restart alike, in the language Thunderbird runs in.
 */
async function setupMenus(): Promise<void> {
  // Reading lastError marks a failed call as handled. An item that failed is simply missing.
  const handled = (): void => void browser.runtime.lastError;
  await browser.menus.removeAll();
  browser.menus.create({ id: MENU_ROOT, title: t("extensionName"), contexts: ["message_list"] }, handled);
  for (const command of COMMANDS) {
    if (command === "trust-address") {
      browser.menus.create({ id: MENU_SEPARATOR, parentId: MENU_ROOT, type: "separator", contexts: ["message_list"] }, handled);
    }
    browser.menus.create(
      { id: command, parentId: MENU_ROOT, title: t(COMMAND_LABELS[command]), contexts: ["message_list"] },
      handled,
    );
  }
}

void setupMenus().catch((error) => console.error("Block Spam: the context menu could not be created", error));

browser.menus.onClicked.addListener((info) => {
  const command = info.menuItemId;
  const selected = info.selectedMessages;
  if (!isCommandName(command) || selected === undefined) {
    return;
  }
  void (async () => runCommand(command, await collect(selected), "menu"))().catch((error) =>
    console.error("Block Spam: the menu command failed", error),
  );
});

browser.runtime.onMessageExternal.addListener((message, sender) => {
  // Only the companion add-on is accepted, and only the four command names.
  const command = (message as { command?: unknown } | null)?.command;
  if (sender.id !== COMPANION_ID || !isCommandName(command)) {
    return undefined;
  }
  return (async () => {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    await runCommand(command, await messagesOfTab(tab), "keys");
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
      // The user cancelled or started again while the code was exchanged: end the new
      // session, and report that this attempt is over rather than a success.
      await revoke(auth).catch(() => false);
      throw new Error(t("signInNoneInProgress"));
    }
    // The attempt is complete. Ending it now (signIn is cleared at once) means that a
    // sign-in started from here on is never touched by this one.
    signInError = "";
    const ended = clearSignIn(true);
    ended.catch(() => undefined); // awaited below; this only keeps an early failure from going unhandled
    let point = pending.accessPointId === null ? undefined : state.accessPoints.find((item) => item.id === pending.accessPointId);
    /** A new service that has to wait for the scan of the sent mail before it is switched on. */
    let waits = false;
    if (point === undefined) {
      // Protection is on and nobody was learned yet: unless the user said "use it anyway", the service waits for the scan.
      waits = state.settings.protection && scanStillNeeded(state) && pending.afterScan !== false && !state.accessPoints.some((item) => item.enabled);
      point = newAccessPoint(
        crypto.randomUUID(),
        {
          type: "chatgpt",
          name: auth.email === "" ? t("chatgptDefaultName") : t("chatgptNamedAccount", auth.email),
          enabled: !waits,
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
    if (waits) {
      await serviceAfterScan(state, need().engine, point);
    }
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

/** The folders of the given accounts with the roles Thunderbird gives them. An account that is gone has none. */
async function folderFacts(accountIds: ReadonlySet<string>): Promise<FolderFacts[]> {
  const facts: FolderFacts[] = [];
  for (const accountId of accountIds) {
    const folders = await browser.folders.query({ accountId }).catch(() => []);
    facts.push(...folders.map((folder) => ({ accountId, path: folder.path, specialUse: folder.specialUse })));
  }
  return facts;
}

/** What the settings page was asked to show. Kept until the page takes it, for a short while. */
let settingsTarget: { target: SettingsTarget; at: number } | null = null;
const SETTINGS_TARGET_MS = 30 * 1000;

function asFolderRef(value: unknown, path: string): FolderRef {
  const record = asRecord(value, path);
  return { accountId: asString(record.accountId, `${path}.accountId`), path: asString(record.path, `${path}.path`) };
}

function asLogActionUndo(value: unknown): LogActionUndo {
  const record = asRecord(value, "undo");
  const move = record.move === null ? null : asRecord(record.move, "undo.move");
  return {
    accountId: asString(record.accountId, "undo.accountId"),
    messageId: asString(record.messageId, "undo.messageId"),
    remove: asArray(record.remove, "undo.remove", asString),
    restore: asArray(record.restore, "undo.restore", validateEntry),
    move: move === null ? null : { from: asFolderRef(move.from, "undo.move.from"), to: asFolderRef(move.to, "undo.move.to") },
  };
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
      repair,
      scan: scan?.progress ?? null,
      signIn: {
        url: signIn?.url ?? null,
        error: signInError,
        capture: browser.webRequest !== undefined,
        accessPointId: signIn?.accessPointId ?? null,
      },
      scoring,
      wish: { waiting: wish.waiting !== null, outcome: wish.outcome, services: wish.services?.ids ?? [], servicesOutcome: wish.servicesOutcome },
    };
  },

  async setProtection({ on }) {
    const { state } = need();
    await switchProtection(state, on === true);
    // Switched by hand: a wish that waited for the scan is settled by this, and what the last one came to is history.
    // AI services that wait for the scan go on waiting.
    await saveWish({ ...wish, waiting: null, outcome: null });
    return null;
  },

  async protectAfterScan() {
    const { state, engine } = need();
    if (state.settings.protection) {
      return null;
    }
    const running = runningRange();
    // Stored before the scan starts: a scan of an empty mailbox can end at once.
    await saveWish({ ...wish, waiting: { since: Date.now(), from: running?.from ?? null, to: running?.to ?? null }, outcome: null });
    if (running === null) {
      beginScan(engine, null, null);
    }
    return null;
  },

  async clearProtectionWish() {
    await saveWish({ ...wish, waiting: null, outcome: null });
    return null;
  },

  async enableAfterScan({ id }) {
    const { state, engine } = need();
    await serviceAfterScan(state, engine, findPoint(state, asString(id, "id")));
    return null;
  },

  async clearServiceWish({ id }) {
    // With a service: "Don't switch on", or its outcome was dismissed. Without one: what the last wish came to was seen.
    await saveWish(
      id === null
        ? { ...wish, servicesOutcome: null }
        : { ...wish, services: withoutService(wish.services, asString(id, "id")), servicesOutcome: outcomeWithoutService(wish.servicesOutcome, asString(id, "id")) },
    );
    return null;
  },

  async updateSettings({ patch }) {
    const { state } = need();
    const { settings, invalid } = applySettingsPatch(state.settings, patch);
    // The menus of the page offer only folders that can be right in their list. The rule holds here too.
    const lists = [settings.sentFoldersAdded, settings.monitoredFoldersAdded, settings.screeningFolders];
    const before = [state.settings.sentFoldersAdded, state.settings.monitoredFoldersAdded, state.settings.screeningFolders];
    if (JSON.stringify(lists) !== JSON.stringify(before)) {
      const [facts, sentDefaults, inboxes] = await Promise.all([
        folderFacts(new Set(lists.flat().map((folder) => folder.accountId))),
        mail.specialFolders("sent"),
        mail.specialFolders("inbox"),
      ]);
      const refused = refusedFolders(state.settings, settings, facts, sentDefaults, inboxes);
      if (refused.length > 0) {
        throw new ValidationError(`folders: not possible in this list: ${refused.map(folderKey).join(", ")}`, "folder-role");
      }
    }
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
    return { value: entry.value, kind: entry.kind, list: entry.list, result };
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

  async restoreEntries({ entries }) {
    const { state, engine } = need();
    const restored = asArray(entries, "entries", validateEntry);
    for (const entry of restored) {
      state.restoreEntry(entry);
    }
    await state.saveEntries();
    mail.resetCache();
    await withKeepAlive(() => engine.sweepIfNeeded());
    return { restored: restored.length };
  },

  async logAction({ entry: raw, action }) {
    const { engine } = need();
    const entry = validateLogEntry(raw, "entry");
    if (!isLogAction(action)) {
      throw new ValidationError("action: expected trust or block");
    }
    mail.resetCache();
    return withKeepAlive(() => engine.runLogAction(entry, action));
  },

  async undoLogAction({ undo: raw }) {
    const { engine } = need();
    const undo = asLogActionUndo(raw);
    mail.resetCache();
    return withKeepAlive(() => engine.undoLogAction(undo));
  },

  async startScan({ from, to }) {
    const { engine } = need();
    if (scan?.progress.running === true) {
      throw new Error(t("errorScanRunning"));
    }
    if (wish.outcome !== null || wish.servicesOutcome !== null) {
      // What the last wish came to is history once the next scan starts.
      await saveWish({ ...wish, outcome: null, servicesOutcome: null });
    }
    beginScan(engine, from, to);
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
    const inboxes = await mail.specialFolders("inbox");
    // The folder may exist already: at the top of the account, or inside the Inbox where the server allows nothing else.
    const places = screeningFolderPaths(folderName, inboxes, accountId);
    let folder = places.map((path) => folders.find((item) => item.path === path)).find((item) => item !== undefined);
    if (folder !== undefined && !state.settings.screeningFolders.some((item) => item.accountId === accountId && item.path === folder?.path)) {
      // A folder of that name that has another job already is not made the screening folder behind the user's back.
      const chosen = chosenFolders(await mail.specialFolders("sent"), inboxes, state.settings);
      if (!mayJoin("screening", { accountId, path: folder.path, specialUse: folder.specialUse }, chosen)) {
        throw new ValidationError(`screening: ${folder.path} has another role`, "folder-role");
      }
    }
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
    const switched = existing.enabled !== definition.enabled;
    Object.assign(existing, definition, { apiKey, needsAttention: false, cooldownUntil: 0, lastError: "" });
    await state.saveAccessPoints();
    if (switched && (wish.services?.ids.includes(existing.id) === true || wish.servicesOutcome?.ids.includes(existing.id) === true)) {
      // Switched by hand: a service that waited for the scan is settled by this, and what its wish came to is history.
      await saveWish({ ...wish, services: withoutService(wish.services, existing.id), servicesOutcome: outcomeWithoutService(wish.servicesOutcome, existing.id) });
    }
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
    if (wish.services?.ids.includes(id) === true || wish.servicesOutcome?.ids.includes(id) === true) {
      await saveWish({ ...wish, services: withoutService(wish.services, id), servicesOutcome: outcomeWithoutService(wish.servicesOutcome, id) });
    }
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

  async listModelsFor({ id, definition: raw, apiKey: newKey }) {
    const { state, ai } = need();
    const existing = id === null ? null : findPoint(state, id);
    const definition = normalizeDefinition(raw);
    if (existing !== null && existing.type !== definition.type) {
      throw new Error(t("errorTypeChange"));
    }
    if (definition.type === "chatgpt") {
      // The models of a ChatGPT plan belong to its sign-in, which only a stored service has.
      if (existing === null) {
        throw new Error(t("errorChatgptNeedsSignIn"));
      }
      return withKeepAlive(() => ai.listModels(existing));
    }
    // Never stored: only this request sees the key that is being typed.
    const point = newAccessPoint(existing?.id ?? "unsaved", definition, (newKey ?? existing?.apiKey ?? "").trim());
    return withKeepAlive(() => ai.listModels(point));
  },

  async startSignIn({ accessPointId, openTab, afterScan }, sender) {
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
    signIn = { ...pending, url, afterScan: afterScan === true ? true : afterScan === false ? false : null };
    if (afterScan === true && accessPointId === null && scanStillNeeded(state) && scan?.progress.running !== true) {
      // "Scan first" was the answer: the scan starts now, and the new service follows it when the sign-in is complete.
      beginScan(need().engine, null, null);
    }
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
    let report;
    try {
      report = applyImport(state, file, mode === "replace" ? "replace" : "merge", {
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
    } catch (error) {
      // The page says in the user's language that the file is not valid, and adds the detail.
      throw error instanceof ValidationError && error.code === "" ? new ValidationError(error.message, "import-invalid") : error;
    }
    let servicesOff = 0;
    if (report.mode === "replace") {
      // The services that waited for the scan are gone with the replaced ones.
      if (wish.services !== null || wish.servicesOutcome !== null) {
        await saveWish({ ...wish, services: null, servicesOutcome: null });
      }
      if (state.settings.protection && scanStillNeeded(state)) {
        // Protection is on and nobody was learned: an imported service that is switched on would get mail from
        // people the user writes to without having been asked. It arrives switched off, and the report says so.
        for (const point of state.accessPoints.filter((item) => item.enabled)) {
          point.enabled = false;
          servicesOff += 1;
        }
      }
    }
    state.whiteAdded = true;
    await state.saveSettings();
    await state.saveEntries();
    await state.saveAccessPoints();
    // A merge can be taken back: what it added and what it moved is kept until the next import.
    const { undo, ...summary } = report;
    const undoId = undo === null ? null : crypto.randomUUID();
    if (undo === null) {
      await store.remove([KEY_LAST_IMPORT]);
    } else {
      await store.set({ [KEY_LAST_IMPORT]: { id: undoId, ...undo } });
    }
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
    return { ...summary, undoId, servicesOff };
  },

  async undoImport({ id }) {
    const { state, engine } = need();
    const raw = (await browser.storage.local.get(KEY_LAST_IMPORT))[KEY_LAST_IMPORT];
    let stored: { id: string; remove: string[]; restore: ReturnType<typeof validateEntry>[] };
    try {
      const record = asRecord(raw, "lastImport");
      stored = { id: asString(record.id, "lastImport.id"), remove: asArray(record.remove, "lastImport.remove", asString), restore: asArray(record.restore, "lastImport.restore", validateEntry) };
    } catch {
      throw new ValidationError("undo: there is no import to take back", "undo-gone");
    }
    if (stored.id !== id) {
      throw new ValidationError("undo: another import was made since", "undo-gone");
    }
    await store.remove([KEY_LAST_IMPORT]);
    let removed = 0;
    for (const key of stored.remove) {
      if (state.removeEntry(key)) {
        removed += 1;
      }
    }
    for (const entry of stored.restore) {
      state.restoreEntry(entry);
    }
    await state.saveEntries();
    mail.resetCache();
    await withKeepAlive(() => engine.sweepIfNeeded());
    return { removed, restored: stored.restore.length };
  },

  async forgetImport() {
    await store.remove([KEY_LAST_IMPORT]);
    return null;
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

  async selection({ tabId }) {
    const { engine } = need();
    const messages = await messagesOfTab(await browser.tabs.get(tabId), SCORE_SELECTED_LIMIT);
    const only = messages.length === 1 ? messages[0] : undefined;
    return {
      count: Math.min(messages.length, SCORE_SELECTED_LIMIT + 1),
      limit: SCORE_SELECTED_LIMIT,
      sender: only === undefined ? null : await engine.describeSender(only),
    };
  },

  async runCommand({ command, tabId }) {
    need();
    if (!isCommandName(command)) {
      throw new ValidationError("command: expected one of the four commands");
    }
    const record = await recordCommand(command, await messagesOfTab(await browser.tabs.get(tabId)), "popup");
    return record ?? { id: "", time: Date.now(), source: "popup", lines: [t("popupNothingSelected")], failed: true, undoable: false };
  },

  async lastCommand() {
    const stored = await storedCommand();
    return { command: stored === null ? null : publicRecord(stored) };
  },

  async undoCommand({ id }) {
    const { engine } = need();
    const stored = await storedCommand();
    if (stored === null || stored.id !== id) {
      // Another command was made since, or this one was taken back already.
      throw new ValidationError("undo: this command is not the last one any more", "undo-gone");
    }
    await store.remove([KEY_LAST_COMMAND]);
    mail.resetCache();
    const outcome = await withKeepAlive(() => engine.undoCommand(stored.undo));
    const lines = [t("commandUndone")];
    if (outcome.moved > 0) {
      lines.push(t("commandUndoMoved", outcome.moved));
    }
    if (outcome.notFound > 0) {
      lines.push(t("commandUndoNotFound", outcome.notFound));
    }
    const failure = outcome.failures[0];
    if (failure !== undefined) {
      lines.push(t("notifyMoveFailed", failure));
    }
    return { lines, failed: failure !== undefined };
  },

  async dismissCommand({ id }) {
    const stored = await storedCommand();
    if (stored !== null && stored.id === id) {
      await store.remove([KEY_LAST_COMMAND]);
    }
    return null;
  },

  async showMessage({ accountId, messageId }) {
    const { engine } = need();
    const found = await engine.findMessage(asString(accountId, "accountId"), asString(messageId, "messageId"));
    if (found === null) {
      return { found: false };
    }
    await browser.messageDisplay.open({ messageId: found.id, location: "tab", active: true });
    return { found: true };
  },

  async repairSetting({ name }) {
    if (fatal === null || repair === null || !isSettingName(name) || !repair.includes(name)) {
      throw new ValidationError("name: not a setting that can be set back on its own");
    }
    const raw = await store.all();
    await store.set({ [KEY_SETTINGS]: withDefaults(raw[KEY_SETTINGS], [name], Date.now()) });
    ready = start();
    await ready;
    requestTick();
    return null;
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

  async showInSettings({ pane, logKey }) {
    const target: SettingsTarget = { pane: asString(pane, "pane"), logKey: logKey === null ? null : asString(logKey, "logKey") };
    settingsTarget = { target, at: Date.now() };
    // A settings page that is already open shows the target at once. One that is about
    // to open asks with takeSettingsTarget.
    const event: PageEvent = { blockSpamEvent: "show", target };
    void browser.runtime.sendMessage(event).catch(() => undefined);
    return null;
  },

  async takeSettingsTarget() {
    const wanted = settingsTarget;
    settingsTarget = null;
    return { target: wanted !== null && Date.now() - wanted.at < SETTINGS_TARGET_MS ? wanted.target : null };
  },

  async welcomeShown() {
    const { state } = need();
    state.settings.chatgptWelcomeShown = true;
    await state.saveSettings();
    return null;
  },
};

/** Requests that still work when stored data is invalid. */
const ALWAYS_ALLOWED: readonly RequestName[] = ["getStatus", "resetData", "repairSetting"];

/** Requests that only read: nothing they do can change what the toolbar button has to show. */
const READ_ONLY: readonly RequestName[] = ["getStatus", "selection", "lastCommand", "takeSettingsTarget", "showInSettings", "showMessage", "listModels", "listModelsFor"];

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
      const result = await handler(message.args ?? {}, sender);
      if (!READ_ONLY.includes(message.blockSpam)) {
        requestAttention("silent");
      }
      return { ok: true, result };
    } catch (error) {
      const code = error instanceof ValidationError ? error.code : "";
      return code === "" ? { ok: false, error: errorText(error) } : { ok: false, error: errorText(error), code };
    }
  })();
});
