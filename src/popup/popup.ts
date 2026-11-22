// The toolbar popup: the state of protection (the same one the settings page shows),
// the last block or trust command with Undo, what the lists and the log say about the
// selected message with the buttons to block and trust its sender, the six newest
// decisions (each opens its entry in the log), the AI test of selected messages and
// the protection switch.

import type { CommandName } from "../core/commandNames";
import type { SenderInfo } from "../core/engine";
import { KEY_ACCESS_POINTS, KEY_ENTRIES, KEY_SETTINGS, logEntryKey } from "../core/keys";
import { findProblems, protectionState, scanIsComplete } from "../core/problems";
import type { AccountFacts, Problem } from "../core/problems";
import type { AccessPoint, Entry, LogEntry, Settings } from "../core/types";
import { hostGranted, refreshGrants } from "../options/aiState";
import { address, addressed, button, byId, errorText, h, iconButton, named, replace, setUnavailable, tNodes } from "../options/dom";
import type { Child } from "../options/dom";
import { formatFullTime, formatLogTime, formatScore, formatShortTime } from "../options/format";
import { icon } from "../options/icons";
import { logReader } from "../options/logData";
import { loadShortcutKeys } from "../options/shortcutKeys";
import type { ShortcutKeys } from "../options/shortcutKeys";
import { drawState } from "../options/state";
import { localizePage, stringsLocale, t, tCode, tn } from "../tb/i18n";
import { commandTitle } from "../tb/commandText";
import { problemLines } from "../tb/stateText";
import { send } from "../tb/protocol";
import type { CommandRecord, SettingsTarget, Status } from "../tb/protocol";

const RECENT = 6;

const stateBox = byId("state");
const content = byId("content");
const commandBox = h("section", { class: "last-command", hidden: true });
const selectionBox = h("section", { class: "selection" });
const recentBox = h("section", { class: "recent" });
const scoreBox = h("div", { class: "score" });
const footer = h("section", { class: "footer" });
/**
 * The last block or trust command that can be taken back: the one a button of this
 * popup just ran, or the one a shortcut or the context menu ran before the popup was
 * opened. It stays until it is undone, dismissed or replaced by the next command.
 */
let lastCommand: { record: CommandRecord; own: boolean } | null = null;
/** What Undo did. Shown in place of the command it took back. */
let undone: { lines: string[]; failed: boolean } | null = null;
let shortcuts: ShortcutKeys = { mac: false, keys: new Map() };
let log: LogEntry[] = [];

async function activeTabId(): Promise<number | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

/**
 * Brings the settings page to the front, and tells it what to show. A page that is
 * already open is only activated: opening it again would load it anew in Thunderbird,
 * and text typed into it would be lost.
 */
async function openSettings(target: SettingsTarget | null = null): Promise<void> {
  if (target !== null) {
    await send("showInSettings", target);
  }
  const address = browser.runtime.getURL("options/options.html");
  const open = (await browser.tabs.query({})).find((tab) => tab.url?.startsWith(address) === true);
  if (open?.id === undefined) {
    await browser.runtime.openOptionsPage();
  } else {
    await browser.tabs.update(open.id, { active: true });
    if (open.windowId !== undefined) {
      await browser.windows.update(open.windowId, { focused: true });
    }
  }
  window.close();
}

/** What the check for problems needs to know about the accounts: their Inbox folders, and whether they have a Junk folder. */
async function accountFacts(): Promise<AccountFacts[]> {
  const [accounts, inboxes, junk] = await Promise.all([
    browser.accounts.list(false),
    browser.folders.query({ specialUse: ["inbox"] }),
    browser.folders.query({ specialUse: ["junk"] }),
  ]);
  const real = (folder: { isRoot?: boolean; isVirtual?: boolean; isUnified?: boolean; isTag?: boolean }): boolean =>
    folder.isRoot !== true && folder.isVirtual !== true && folder.isUnified !== true && folder.isTag !== true;
  return accounts.map((account) => ({
    id: account.id,
    inboxes: inboxes.filter((folder) => folder.accountId === account.id && real(folder)).map((folder) => ({ accountId: account.id, path: folder.path })),
    hasJunk: junk.some((folder) => folder.accountId === account.id && real(folder)),
  }));
}

/** The warnings the Overview of the settings page shows at the moment, one per cause. They matter here while protection is on. */
async function currentProblems(settings: Settings, accessPoints: AccessPoint[], accounts: AccountFacts[], onlyOwnAddresses: boolean): Promise<Problem[]> {
  if (!settings.protection) {
    return [];
  }
  await refreshGrants(accessPoints.filter((point) => point.enabled && point.needsAttention)).catch(() => false);
  return findProblems({ settings, accessPoints, accounts, onlyOwnAddresses, hostGranted, now: Date.now() });
}

/**
 * After a part of the popup was drawn anew: puts the keyboard focus back on the
 * control of the given kind, or else on the first button for the selected message, or
 * else on the button that opens the settings. The focus is never left on nothing.
 */
function restoreFocus(kind: string | null): void {
  const same = kind === null ? undefined : [...document.querySelectorAll<HTMLElement>("[data-focus]")].find((candidate) => candidate.dataset.focus === kind && candidate.closest("[hidden]") === null);
  (same ?? selectionBox.querySelector<HTMLElement>(".commands button") ?? byId("open-settings")).focus();
}

// ---------------------------------------------------------------------------
// The last command, with Undo.

function resultBox(lines: readonly string[], failed: boolean, caption: string, actions: Child[]): HTMLElement {
  return h(
    "div",
    { class: `result ${failed ? "error" : "ok"}`, attrs: { role: failed ? "alert" : "status" } },
    icon(failed ? "warning" : "success"),
    // A line can name addresses and domains: they break like addresses.
    h("div", { class: "result-text" }, caption === "" ? null : h("div", { class: "description", text: caption }), ...lines.map((line) => h("div", {}, ...addressed(line)))),
    actions.some((action) => action !== null) ? h("div", { class: "result-actions" }, ...actions) : null,
  );
}

function drawCommand(tabId: number | null): void {
  const shown = lastCommand;
  if (shown === null) {
    commandBox.hidden = undone === null;
    // What Undo did stays until the next command: like the result of the command itself, it can be closed.
    const close = iconButton("close", t("dismiss"), () => {
      undone = null;
      drawCommand(tabId);
      restoreFocus(null);
    });
    replace(commandBox, undone === null ? null : resultBox(undone.lines, undone.failed, "", [close]));
    return;
  }
  const { record } = shown;
  const refresh = async (): Promise<void> => {
    log = (await logReader.load()).entries;
    drawRecent();
    await drawSelection(tabId);
  };
  const undo = !record.undoable
    ? null
    : button(
        t("undo"),
        () => {
          undo?.setAttribute("aria-disabled", "true");
          void (async () => {
            try {
              undone = await send("undoCommand", { id: record.id });
            } catch (error) {
              undone = { lines: [errorText(error)], failed: true };
            }
            lastCommand = null;
            drawCommand(tabId);
            await refresh();
            // Undo is gone with the command it took back.
            restoreFocus(null);
          })();
        },
        "small",
      );
  if (undo !== null) {
    // The name says what is taken back: the first line of what the command did.
    named(undo, record.lines[0] ?? "");
  }
  const dismiss = iconButton("close", t("dismiss"), () => {
    lastCommand = null;
    drawCommand(tabId);
    restoreFocus(null);
    if (record.undoable) {
      void send("dismissCommand", { id: record.id }).catch(() => undefined);
    }
  });
  // A command that was not made here, in this panel, says when it was made: the time, and the date when that was not today.
  const caption = shown.own ? "" : t("popupLastCommand", formatLogTime(record.time, Date.now()));
  commandBox.hidden = false;
  replace(commandBox, resultBox(record.lines, record.failed, caption, [undo, dismiss]));
}

// ---------------------------------------------------------------------------
// Block and trust for the selected messages: the same four commands as the shortcuts.

/** `name` is the accessible name: the label and its object. `title` is the tooltip: the whole sentence of what the command does. */
function commandButton(label: string, name: string, command: CommandName, tabId: number, title = "", unchanged = false): HTMLButtonElement {
  const key = shortcuts.keys.get(command);
  const element = h(
    "button",
    { type: "button", attrs: { "aria-label": name } },
    // The label stands at the start of the button and its key at the end.
    h("span", { class: "label", text: label }),
    key === undefined ? null : h("span", { class: "key", text: key, attrs: { "aria-hidden": "true" } }),
  );
  element.dataset.focus = command;
  if (title !== "") {
    element.title = title;
  }
  if (unchanged) {
    // The sender is on this list already and the message is where the command would put it.
    setUnavailable(element, true, t("popupNoChange"));
  }
  element.addEventListener("click", () => {
    if (element.getAttribute("aria-disabled") === "true") {
      return;
    }
    for (const other of selectionBox.querySelectorAll(".commands button")) {
      other.setAttribute("aria-disabled", "true");
    }
    void (async () => {
      undone = null;
      try {
        lastCommand = { record: await send("runCommand", { command, tabId }), own: true };
      } catch (error) {
        lastCommand = { record: { id: "", time: Date.now(), source: "popup", lines: [errorText(error)], failed: true, undoable: false }, own: true };
      }
      drawCommand(tabId);
      log = (await logReader.load()).entries;
      drawRecent();
      await drawSelection(tabId);
      // The buttons were drawn anew: the keyboard stays on the one that was pressed, also when it is unavailable now.
      restoreFocus(command);
    })();
  });
  return element;
}

/** What the lists say about the sender now. */
function listLine(deciding: Entry | null): HTMLElement {
  return h(
    "p",
    { class: `on-list ${deciding === null ? "neither" : deciding.list}` },
    ...(deciding === null ? [t("popupOnNeither")] : tNodes(deciding.list === "white" ? "popupOnWhite" : "popupOnBlack", address(deciding.value))),
  );
}

function outcomeText(entry: LogEntry, withAction: boolean): string {
  // Tests and observed decisions moved nothing: they say so, and their dot is hollow.
  const marker = entry.test ? t("logTestBadge") : entry.observed ? t("logObservedBadge") : "";
  const score = entry.score === null ? "" : ` ${formatScore(entry.score, stringsLocale())}`;
  const action = !withAction || entry.action === "none" ? "" : `, ${entry.observed ? tCode("actionObserved", entry.action) : tCode("action", entry.action)}`;
  return `${tCode("outcome", entry.outcome)}${score}${action}${marker === "" ? "" : ` (${marker})`}`;
}

/** What Block Spam decided about the selected message, as a row that opens its entry in the log. */
function decisionOf(sender: SenderInfo): HTMLElement | null {
  if (sender.messageId === "") {
    return null;
  }
  const entries = log.filter((entry) => entry.messageId === sender.messageId && entry.accountId === sender.accountId);
  // The decision itself comes before a test score of the same message.
  const entry = entries.find((item) => !item.test) ?? entries[0];
  if (entry === undefined) {
    return null;
  }
  const outcome = outcomeText(entry, true);
  const time = formatShortTime(entry.time, Date.now());
  const row = h(
    "button",
    {
      type: "button",
      class: "decision own",
      // The tooltip has all of what the row shows, for when it is too long for its line, and the reason.
      title: `${outcome}\n${tCode("reason", entry.reason)}\n${formatFullTime(entry.time)}`,
      // The tooltip repeats what the row shows, for when it is cut. A screen reader hears the name and, as the description, only what the name does not say: the reason.
      attrs: { "aria-label": t("popupDecisionLabel", outcome, time), "aria-description": tCode("reason", entry.reason) },
    },
    h("span", { class: `dot outcome-${entry.outcome}${entry.test || entry.observed ? " hollow" : ""}`, attrs: { "aria-hidden": "true" } }),
    h("span", { class: "what", text: outcome }),
    h("span", { class: "when", text: time }),
  );
  row.addEventListener("click", () => void openSettings({ pane: "log", logKey: logEntryKey(entry) }).catch(() => undefined));
  return row;
}

async function drawSelection(tabId: number | null, quiet = false): Promise<void> {
  let count = 0;
  let limit = scoreState.limit;
  let sender: SenderInfo | null = null;
  if (tabId !== null) {
    try {
      ({ count, limit, sender } = await send("selection", { tabId }));
    } catch {
      count = 0;
    }
  }
  selectionBox.hidden = false;
  scoreState = { ...scoreState, count, limit };
  drawScoreButton();
  if (count === 0) {
    // Right after installation the popup points at setup and nothing else.
    selectionBox.hidden = quiet;
    replace(selectionBox, h("p", { class: "description", text: t("popupNoSelection") }));
    return;
  }
  if (tabId === null) {
    return;
  }
  const many = count > 1 || sender === null;
  const unchanged = (command: CommandName): boolean => sender?.unchanged.includes(command) === true;
  const title = (command: CommandName): string => commandTitle(command, sender?.effects[command]);
  const parts: Child[] = [];
  /** What stands between the address row and the domain row: the line that names the domain. */
  let domainLine: Child = null;
  let domainButtons: Child[] = [];
  /** Said in place of the domain row for a sender at a public mail provider. */
  let publicNote: Child = null;
  if (many) {
    parts.push(h("h2", { text: tn("popupSelectedMany", count) }));
    domainLine = h("div", { class: "description domain-line", text: t("popupDomains") });
    domainButtons = [
      commandButton(t("popupBlockShort"), t("cmdBlockDomain"), "block-domain", tabId),
      commandButton(t("popupTrustShort"), t("cmdTrustDomain"), "trust-domain", tabId),
    ];
  } else if (sender !== null) {
    parts.push(h("h2", { text: t("popupSelectedOne") }));
    parts.push(
      h(
        "div",
        { class: "sender" },
        sender.address === "" ? t("logUnknownSender") : address(sender.address),
        sender.via === "" ? null : h("span", { class: "description" }, " ", t("logForwardedBy"), " ", address(sender.via)),
      ),
    );
    if (sender.own) {
      replace(selectionBox, ...parts, h("p", { class: "description", text: t("popupOwnAddress") }));
      return;
    }
    if (sender.address !== "") {
      // What the lists say about this sender, and what was decided about this very message.
      parts.push(listLine(sender.deciding));
    }
    parts.push(decisionOf(sender));
    if (sender.address === "") {
      parts.push(h("p", { class: "description", text: t("popupUnknownSender") }));
    } else if (sender.domainTarget?.kind === "domain") {
      const domain = sender.domainTarget.value;
      // When the entry of the domain is the one that decides this sender, the line says so: the buttons under it change that entry.
      domainLine =
        sender.deciding?.kind === "domain" && sender.deciding.value === domain
          ? h("div", { class: "description domain-line" }, ...tNodes("popupDomainDeciding", address(domain)))
          : h("div", { class: "description domain-line" }, t("popupDomain"), " ", address(domain), ":");
      domainButtons = [
        commandButton(t("popupBlockShort"), t("popupBlockDomainNamed", domain), "block-domain", tabId, title("block-domain"), unchanged("block-domain")),
        commandButton(t("popupTrustShort"), t("popupTrustDomainNamed", domain), "trust-domain", tabId, title("trust-domain"), unchanged("trust-domain")),
      ];
    } else {
      publicNote = h("p", { class: "description public-note", text: t("popupPublicNote") });
    }
  }
  const blockLabel = t(many ? "popupBlockMany" : "popupBlock");
  const trustLabel = t(many ? "popupTrustMany" : "popupTrust");
  // The name is the label and its object: the address the button acts on.
  const named = (label: string): string => (sender === null || sender.address === "" || many ? label : t("labelNamed", label, sender.address));
  replace(
    selectionBox,
    ...parts,
    // The main controls of the panel: two columns of equal width that fill it, Block under Block and Trust under Trust.
    h(
      "div",
      { class: "commands" },
      commandButton(blockLabel, named(blockLabel), "block-address", tabId, title("block-address"), unchanged("block-address")),
      commandButton(trustLabel, named(trustLabel), "trust-address", tabId, title("trust-address"), unchanged("trust-address")),
      domainLine,
      ...domainButtons,
      publicNote,
    ),
  );
}

// ---------------------------------------------------------------------------
// The last decisions. Each row opens its entry in the log of the settings page.

function decisionRow(entry: LogEntry, now: number): HTMLElement {
  const sender = entry.sender === "" ? (entry.via === "" ? t("logUnknownSender") : entry.via) : entry.sender;
  const outcome = outcomeText(entry, false);
  const time = formatShortTime(entry.time, now);
  const row = h(
    "button",
    {
      type: "button",
      class: "decision",
      // The tooltip has all of what the row shows, for an address that is too long for its line, and the subject and the reason.
      title: `${sender}\n${entry.subject}\n${outcome}\n${tCode("reason", entry.reason)}\n${formatFullTime(entry.time)}`,
      // A screen reader hears the name and, as the description, only what the name does not say: the subject and the reason.
      attrs: { "aria-label": t("popupRowLabel", sender, outcome, time), "aria-description": [entry.subject, tCode("reason", entry.reason)].filter((part) => part !== "").join(". ") },
    },
    h("span", { class: `dot outcome-${entry.outcome}${entry.test || entry.observed ? " hollow" : ""}`, attrs: { "aria-hidden": "true" } }),
    h("span", { class: "who", text: sender }),
    h("span", { class: "what", text: outcome }),
    h("span", { class: "when", text: time }),
  );
  row.addEventListener("click", () => void openSettings({ pane: "log", logKey: logEntryKey(entry) }).catch(() => undefined));
  return h("li", {}, row);
}

function drawRecent(): void {
  const now = Date.now();
  const entries = log.slice(0, RECENT);
  // The popup shows the six newest. The way to all of them stands next to the heading.
  const all = button(t("otherWaysLogLink"), () => void openSettings({ pane: "log", logKey: null }).catch(() => undefined), "link");
  all.dataset.focus = "open-log";
  replace(
    recentBox,
    h("div", { class: "heading-row" }, h("h2", { text: t("popupRecent"), id: "recent-title" }), entries.length === 0 ? null : all),
    entries.length === 0
      ? h("p", { class: "description", text: t("popupNoDecisions") })
      : // The list scrolls when the popup is full, and can then take the focus: it is named by its heading.
        h("ul", { class: "decisions", attrs: { "aria-labelledby": "recent-title" } }, ...entries.map((entry) => decisionRow(entry, now))),
  );
}

// ---------------------------------------------------------------------------
// "Test AI on selected messages": sends the selection to the AI and only logs the scores.

function showScoreMessage(message: string, isError = false, withLog = false): void {
  // What the test said stays until it is closed or the next test is asked for: it has the close button of every result.
  const close = iconButton("close", t("dismiss"), () => {
    replace(scoreBox, scoreButton());
    restoreFocus("score");
  });
  // A result that sends the reader to the log for the reasons leads there.
  const openLog = withLog ? button(t("otherWaysLogLink"), () => void openSettings({ pane: "log", logKey: null }).catch(() => undefined), "link") : null;
  replace(scoreBox, resultBox([message], isError, "", [openLog, close]), scoreButton());
  // The buttons of the question are gone: the keyboard goes back to the button that asks again.
  restoreFocus("score");
}

/** Confirmation: the content of the selected messages, and how many they are, is sent to the configured AI. */
function confirmScoring(tabId: number, count: number): void {
  const send_ = button(t("popupScoreSend"), () => {
    replace(scoreBox, h("p", { class: "description", attrs: { role: "status" } }, h("span", { class: "spinner" }), " ", t("popupScoring")));
    void (async () => {
      try {
        const summary = await send("scoreSelected", { tabId });
        // How many got no score is said only when some did not: "Without a score: 0." would be noise.
        // When none got one there are no scores to point at: the line says that no service answered, and that the log holds the reason.
        const done =
          summary.failed === 0 ? t("popupScoreDone", summary.scored) : summary.scored === 0 ? tn("popupScoreNone", summary.failed) : t("popupScoreDoneFailed", summary.scored, summary.failed);
        // A run in which a message got no score is not a success: its result has the warning form, and leads to the log.
        showScoreMessage(summary.selected === 0 ? t("popupNothingSelected") : done, summary.selected === 0 || summary.failed > 0, summary.selected > 0 && summary.failed > 0);
        log = (await logReader.load()).entries;
        drawRecent();
        await drawSelection(tabId);
      } catch (error) {
        showScoreMessage(errorText(error), true);
      }
    })();
  }, "primary");
  replace(
    scoreBox,
    h("p", { text: t("popupScoreConfirm", count) }),
    h(
      "div",
      { class: "row" },
      send_,
      button(t("cancel"), () => {
        replace(scoreBox, scoreButton());
        restoreFocus("score");
      }),
    ),
  );
  send_.focus();
}

/** How many messages are selected, and whether a test is running already: what the test button needs to know. */
let scoreState: { count: number; limit: number; scoring: boolean } = { count: 0, limit: Number.POSITIVE_INFINITY, scoring: false };

function scoreButton(): HTMLButtonElement {
  const element = button(t("popupScoreSelected"), () => {
    void (async () => {
      try {
        const tabId = await activeTabId();
        if (tabId === null) {
          showScoreMessage(t("popupNothingSelected"), true);
          return;
        }
        const { count, limit } = await send("selection", { tabId });
        if (count === 0) {
          showScoreMessage(t("popupNothingSelected"), true);
        } else if (count > limit) {
          showScoreMessage(t("popupScoreTooMany", limit), true);
        } else {
          confirmScoring(tabId, count);
        }
      } catch (error) {
        showScoreMessage(errorText(error), true);
      }
    })();
  });
  // The label is short enough for one row with the switch in every language. The tooltip is the whole sentence.
  element.title = t("popupScoreSelectedTitle");
  element.dataset.role = "score";
  element.dataset.focus = "score";
  element.classList.add("small");
  drawScoreButton(element);
  return element;
}

/** The test needs a selection and one run at a time. Until then the button is unavailable and its tooltip says what is missing. */
function drawScoreButton(element: HTMLElement | null = scoreBox.querySelector<HTMLElement>('button[data-role="score"]')): void {
  if (element === null) {
    return;
  }
  setUnavailable(element, false);
  if (scoreState.scoring) {
    setUnavailable(element, true, t("errorScoringRunning"));
  } else if (scoreState.count === 0) {
    setUnavailable(element, true, t("popupNothingSelected"));
  } else if (scoreState.count > scoreState.limit) {
    setUnavailable(element, true, t("popupScoreTooMany", scoreState.limit));
  }
}

/** Draws the popup anew and puts the keyboard focus back on the control of the same kind. */
async function redraw(kind: string | null): Promise<void> {
  await draw();
  restoreFocus(kind);
}

/**
 * The protection switch. While protection waits for the scan, the popup says so and offers to call it off.
 * Switching on while a scan runs and something acts on unknown senders (an AI service is on, or mail without a
 * verdict is moved) waits for that scan, as the settings page does by default: mail from people the scan has not
 * learned yet is neither sent to the AI nor moved.
 */
function switchBox(settings: Settings, status: Status, hasAi: boolean): HTMLElement {
  if (status.wish.waiting) {
    const cancel = button(t("wishCancel"), () => {
      setUnavailable(cancel, true);
      void send("clearProtectionWish", {})
        .catch((error: unknown) => showScoreMessage(errorText(error), true))
        .finally(() => void redraw("toggle"));
    });
    cancel.dataset.focus = "toggle";
    cancel.classList.add("small");
    // Described by the sentence it stands under, so that the focus that lands on it reads both.
    cancel.setAttribute("aria-describedby", "wish-waiting");
    return h("div", { class: "switch waiting" }, h("p", { class: "description", id: "wish-waiting", text: t("wishWaiting"), attrs: { role: "status" } }), cancel);
  }
  // The same holds while mail without a verdict is moved: until the scan has ended, people it has not learned yet count as unknown senders.
  const afterScan = !settings.protection && status.scan?.running === true && (hasAi || settings.noVerdictAction !== "leave");
  const toggle = button(t(settings.protection ? "protectionSwitchOff" : "protectionSwitchOn"), () => {
    setUnavailable(toggle, true);
    void (afterScan ? send("protectAfterScan", {}) : send("setProtection", { on: !settings.protection }))
      .catch((error: unknown) => showScoreMessage(errorText(error), true))
      // The footer is drawn anew with the other label: the keyboard stays on the switch.
      .finally(() => void redraw("toggle"));
  });
  toggle.dataset.focus = "toggle";
  // A rare and far-reaching action: a small button at the end of the footer, quieter than the buttons for the selected message.
  toggle.classList.add("small");
  return h("div", { class: "switch" }, toggle);
}

/** While protection waits for the scan the popup asks once a second whether the scan has ended, and then shows what came of it. */
let waitTimer: ReturnType<typeof setInterval> | null = null;

function watchWish(waiting: boolean): void {
  if (!waiting && waitTimer !== null) {
    clearInterval(waitTimer);
    waitTimer = null;
  }
  if (waiting && waitTimer === null) {
    waitTimer = setInterval(() => {
      void send("getStatus", {})
        .then((status) => {
          if (!status.wish.waiting) {
            const active = document.activeElement;
            return redraw(active instanceof HTMLElement ? (active.dataset.focus ?? null) : null);
          }
          return undefined;
        })
        .catch(() => undefined);
    }, 1000);
  }
}

async function draw(): Promise<void> {
  const [status, stored, keys] = await Promise.all([
    send("getStatus", {}),
    browser.storage.local.get([KEY_SETTINGS, KEY_ACCESS_POINTS, KEY_ENTRIES]),
    loadShortcutKeys().catch(() => shortcuts),
  ]);
  shortcuts = keys;
  const settings = status.fatal === null ? ((stored[KEY_SETTINGS] as Settings | undefined) ?? null) : null;
  watchWish(status.wish.waiting);
  if (status.fatal !== null || settings === null) {
    // Stored data that failed validation is not read any further.
    drawState(stateBox, "invalid", 0, true);
    replace(content, h("section", {}, h("p", { text: t("popupDataProblemText") }), h("div", { class: "row" }, button(t("popupOpenSettings"), () => void openSettings()))));
    return;
  }
  const accessPoints = (stored[KEY_ACCESS_POINTS] as AccessPoint[] | undefined) ?? [];
  const entries = (stored[KEY_ENTRIES] as Entry[] | undefined) ?? [];
  // Learned: the white list holds more than the user's own addresses, or a scan found that there is nobody to add.
  const learned = entries.some((entry) => entry.list === "white" && entry.source !== "identity") || scanIsComplete(status.scan);
  // The popup points at setup until then, or until protection was switched on without it.
  const setupDone = learned || settings.protection;
  // When the accounts cannot be read, the problems of the AI services are still found, and the popup does not claim that there is no account.
  const accounts = await accountFacts().catch(() => null);
  const problems = await currentProblems(settings, accessPoints, accounts ?? [], !learned);
  const shown = protectionState({
    invalid: false,
    accounts: accounts === null ? 1 : accounts.length,
    protection: settings.protection,
    observation: settings.observation,
    problems: problems.length,
    waiting: status.wish.waiting,
  });
  drawState(stateBox, shown, problems.length, true);
  if (shown === "no-account") {
    // Without a mail account there is nothing to select, to scan or to protect. Setup is not pointed at: its first step cannot be done.
    replace(content, h("section", {}, h("p", { text: t("noAccounts") })));
    return;
  }
  const hasAi = accessPoints.some((point) => point.enabled);
  const tabId = await activeTabId();
  scoreState = { ...scoreState, scoring: status.scoring };
  // A command made with a shortcut or from the context menu since the popup was last open is shown with Undo.
  if (lastCommand === null || !lastCommand.own) {
    const { command } = await send("lastCommand", {}).catch(() => ({ command: null }));
    lastCommand = command === null ? null : { record: command, own: false };
  }
  log = (await logReader.load()).entries;
  drawCommand(tabId);

  if (!setupDone) {
    // A scan that is running is said to be running: "scan first" is true only before it.
    const scanning = status.scan?.running === true;
    replace(
      content,
      commandBox,
      h(
        "section",
        { class: "setup" },
        h("h2", { text: t("popupSetupTitle") }),
        h("p", { class: "description", text: t(status.wish.waiting ? "popupSetupWaiting" : scanning ? "popupSetupScanning" : "popupSetupText") }),
        h("div", { class: "row" }, button(t("popupOpenSetup"), () => void openSettings({ pane: "overview", logKey: null }), scanning ? "" : "primary")),
      ),
      selectionBox,
    );
    await drawSelection(tabId, true);
    return;
  }

  if (scoreBox.childElementCount === 0) {
    replace(scoreBox, scoreButton());
  }
  scoreBox.hidden = !hasAi;
  replace(footer, scoreBox, switchBox(settings, status, hasAi));
  // The warnings themselves, each with its fix, are on the Overview of the settings page. Here the state in the header counts them and this line names them.
  const notice =
    problems.length === 0
      ? null
      : h(
          "section",
          { class: "notice" },
          icon("warning"),
          // One line that says what this is, then one cause per line.
          h(
            "div",
            { class: "notice-text", attrs: { role: "status" } },
            h("div", { class: "notice-title", text: t("popupProblemsTitle") }),
            h("ul", { class: "causes" }, ...problemLines(problems, accessPoints, stringsLocale()).map((line) => h("li", {}, ...addressed(line)))),
          ),
          button(t("popupShowProblems"), () => void openSettings({ pane: "overview", logKey: null }), "small"),
        );
  replace(content, notice, commandBox, selectionBox, recentBox, footer);
  drawRecent();
  await drawSelection(tabId);
}

localizePage();
byId("open-settings").addEventListener("click", () => void openSettings());
void draw().catch((error: unknown) => {
  stateBox.className = "state invalid";
  replace(stateBox, icon("warning"), errorText(error));
});
