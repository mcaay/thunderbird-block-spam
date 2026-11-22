// The toolbar popup: the state of protection, the last block or trust command with
// Undo, what the lists and the log say about the selected message with the buttons to
// block and trust its sender, the last ten decisions (each opens its entry in the
// log), the AI test of selected messages and the protection switch.

import type { CommandName } from "../core/commandNames";
import type { SenderInfo } from "../core/engine";
import { KEY_ACCESS_POINTS, KEY_ENTRIES, KEY_SETTINGS, logEntryKey } from "../core/keys";
import { findProblems, scanIsComplete } from "../core/problems";
import type { AccountFacts } from "../core/problems";
import type { AccessPoint, Entry, LogEntry, Settings } from "../core/types";
import { address, button, byId, errorText, h, iconButton, replace, setUnavailable, tNodes } from "../options/dom";
import type { Child } from "../options/dom";
import { formatFullTime, formatLogTime, formatScore, formatShortTime } from "../options/format";
import { icon } from "../options/icons";
import { logReader } from "../options/logData";
import { loadShortcutKeys } from "../options/shortcutKeys";
import type { ShortcutKeys } from "../options/shortcutKeys";
import { localizePage, stringsLocale, t, tCode, tn } from "../tb/i18n";
import { send } from "../tb/protocol";
import type { CommandRecord, SettingsTarget, Status } from "../tb/protocol";

const RECENT = 10;

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

/** The same state as on the Overview of the settings page. */
function drawState(status: Status, settings: Settings | null, problems: boolean): void {
  if (status.fatal !== null || settings === null) {
    stateBox.className = "state problems";
    replace(stateBox, icon("warning"), t("popupDataProblem"));
    return;
  }
  const kind = !settings.protection ? "off" : problems ? "problems" : settings.observation ? "observing" : "on";
  stateBox.className = `state ${kind}`;
  replace(
    stateBox,
    icon(kind === "problems" ? "warning" : kind === "off" ? "off" : "success"),
    t(kind === "off" ? "stateOff" : kind === "problems" ? "stateProblems" : kind === "observing" ? "stateObserving" : "stateOn"),
  );
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

/** How many warnings the Overview of the settings page shows at the moment. They matter here while protection is on. */
async function countProblems(settings: Settings, accessPoints: AccessPoint[], onlyOwnAddresses: boolean): Promise<number> {
  if (!settings.protection) {
    return 0;
  }
  // When the accounts cannot be read, the problems of the AI services are still found.
  const accounts = await accountFacts().catch(() => []);
  return findProblems({ settings, accessPoints, accounts, onlyOwnAddresses, now: Date.now() }).length;
}

// ---------------------------------------------------------------------------
// The last command, with Undo.

function resultBox(lines: readonly string[], failed: boolean, caption: string, actions: Child[]): HTMLElement {
  return h(
    "div",
    { class: `result ${failed ? "error" : "ok"}`, attrs: { role: failed ? "alert" : "status" } },
    icon(failed ? "warning" : "success"),
    h("div", { class: "result-text" }, caption === "" ? null : h("div", { class: "description", text: caption }), ...lines.map((line) => h("div", { text: line }))),
    actions.some((action) => action !== null) ? h("div", { class: "result-actions" }, ...actions) : null,
  );
}

function drawCommand(tabId: number | null): void {
  const shown = lastCommand;
  if (shown === null) {
    commandBox.hidden = undone === null;
    replace(commandBox, undone === null ? null : resultBox(undone.lines, undone.failed, "", []));
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
          })();
        },
        "small",
      );
  const dismiss = iconButton("close", t("dismiss"), () => {
    lastCommand = null;
    drawCommand(tabId);
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

function commandButton(label: string, name: string, command: CommandName, tabId: number, cls: string, unchanged = false): HTMLButtonElement {
  const key = shortcuts.keys.get(command);
  const element = h(
    "button",
    { type: "button", class: cls, attrs: { "aria-label": name } },
    h("span", { text: label }),
    key === undefined ? null : h("span", { class: "key", text: key, attrs: { "aria-hidden": "true" } }),
  );
  if (unchanged) {
    // The sender is on this list already and the message is where the command would put it.
    setUnavailable(element, true);
    element.title = t("popupNoChange");
    element.setAttribute("aria-label", `${name}. ${t("popupNoChange")}`);
  }
  element.addEventListener("click", () => {
    if (element.getAttribute("aria-disabled") === "true") {
      return;
    }
    for (const other of selectionBox.querySelectorAll(".row button")) {
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
      title: `${tCode("reason", entry.reason)}\n${formatFullTime(entry.time)}`,
      attrs: { "aria-label": t("popupDecisionLabel", outcome, time) },
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
  const parts: Child[] = [];
  let domainRow: Child = null;
  if (many) {
    parts.push(h("h2", { text: tn("popupSelectedMany", count) }));
    domainRow = h(
      "div",
      { class: "domain" },
      h("div", { class: "description", text: t("popupDomains") }),
      h(
        "div",
        { class: "row" },
        commandButton(t("popupBlockShort"), t("cmdBlockDomain"), "block-domain", tabId, "small"),
        commandButton(t("popupTrustShort"), t("cmdTrustDomain"), "trust-domain", tabId, "small"),
      ),
    );
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
      domainRow = h(
        "div",
        { class: "domain" },
        h("div", { class: "description" }, t("popupDomain"), " ", address(domain), ":"),
        h(
          "div",
          { class: "row" },
          commandButton(t("popupBlockShort"), t("popupBlockDomainNamed", domain), "block-domain", tabId, "small", unchanged("block-domain")),
          commandButton(t("popupTrustShort"), t("popupTrustDomainNamed", domain), "trust-domain", tabId, "small", unchanged("trust-domain")),
        ),
      );
    } else {
      domainRow = h("p", { class: "description", text: t("popupPublicNote") });
    }
  }
  replace(
    selectionBox,
    ...parts,
    h(
      "div",
      { class: "row" },
      commandButton(t(many ? "popupBlockMany" : "popupBlock"), t(many ? "popupBlockMany" : "popupBlock"), "block-address", tabId, "", unchanged("block-address")),
      commandButton(t(many ? "popupTrustMany" : "popupTrust"), t(many ? "popupTrustMany" : "popupTrust"), "trust-address", tabId, "", unchanged("trust-address")),
    ),
    domainRow,
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
      title: `${sender}\n${entry.subject}\n${tCode("reason", entry.reason)}\n${formatFullTime(entry.time)}`,
      attrs: { "aria-label": t("popupRowLabel", sender, outcome, time) },
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
  replace(
    recentBox,
    h("h2", { text: t("popupRecent"), id: "recent-title" }),
    entries.length === 0
      ? h("p", { class: "description", text: t("popupNoDecisions") })
      : // The list scrolls when the popup is full, and can then take the focus: it is named by its heading.
        h("ul", { class: "decisions", attrs: { "aria-labelledby": "recent-title" } }, ...entries.map((entry) => decisionRow(entry, now))),
  );
}

// ---------------------------------------------------------------------------
// "Test AI on selected messages": sends the selection to the AI and only logs the scores.

function showScoreMessage(message: string, isError = false): void {
  replace(scoreBox, h("p", { class: isError ? "result error" : "description", text: message, attrs: { role: isError ? "alert" : "status" } }), scoreButton());
}

/** Confirmation: the content of the selected messages, and how many they are, is sent to the configured AI. */
function confirmScoring(tabId: number, count: number): void {
  const send_ = button(t("popupScoreSend"), () => {
    replace(scoreBox, h("p", { class: "description", attrs: { role: "status" } }, h("span", { class: "spinner" }), " ", t("popupScoring")));
    void (async () => {
      try {
        const summary = await send("scoreSelected", { tabId });
        showScoreMessage(summary.selected === 0 ? t("popupNothingSelected") : t("popupScoreDone", summary.scored, summary.failed), summary.selected === 0);
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
    h("div", { class: "row" }, send_, button(t("cancel"), () => replace(scoreBox, scoreButton()))),
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
  element.dataset.role = "score";
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

function toggleButton(settings: Settings): HTMLButtonElement {
  const toggle = button(t(settings.protection ? "protectionSwitchOff" : "protectionSwitchOn"), () => {
    toggle.disabled = true;
    void send("setProtection", { on: !settings.protection })
      .catch((error: unknown) => showScoreMessage(errorText(error), true))
      .finally(() => void draw());
  });
  return toggle;
}

async function draw(): Promise<void> {
  const [status, stored, keys] = await Promise.all([
    send("getStatus", {}),
    browser.storage.local.get([KEY_SETTINGS, KEY_ACCESS_POINTS, KEY_ENTRIES]),
    loadShortcutKeys().catch(() => shortcuts),
  ]);
  shortcuts = keys;
  const settings = status.fatal === null ? ((stored[KEY_SETTINGS] as Settings | undefined) ?? null) : null;
  const accessPoints = (stored[KEY_ACCESS_POINTS] as AccessPoint[] | undefined) ?? [];
  const entries = (stored[KEY_ENTRIES] as Entry[] | undefined) ?? [];
  // Learned: the white list holds more than the user's own addresses, or a scan found that there is nobody to add.
  const learned = entries.some((entry) => entry.list === "white" && entry.source !== "identity") || scanIsComplete(status.scan);
  // The popup points at setup until then, or until protection was switched on without it.
  const setupDone = learned || settings?.protection === true;
  const problems = status.fatal === null && settings !== null ? await countProblems(settings, accessPoints, !learned) : 0;
  drawState(status, settings, problems > 0);
  if (status.fatal !== null || settings === null) {
    // Stored data that failed validation is not read any further.
    replace(content, h("section", {}, h("p", { text: t("popupDataProblemText") }), h("div", { class: "row" }, button(t("popupOpenSettings"), () => void openSettings()))));
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
    replace(
      content,
      commandBox,
      h(
        "section",
        { class: "setup" },
        h("h2", { text: t("popupSetupTitle") }),
        h("p", { class: "description", text: t("popupSetupText") }),
        h("div", { class: "row" }, button(t("popupOpenSetup"), () => void openSettings({ pane: "overview", logKey: null }), "primary")),
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
  replace(footer, scoreBox, h("div", { class: "row end" }, toggleButton(settings)));
  // The warnings themselves, each with its fix, are on the Overview of the settings page.
  const notice =
    problems === 0
      ? null
      : h(
          "section",
          { class: "notice" },
          icon("warning"),
          h("span", { class: "notice-text", text: tn("popupProblems", problems), attrs: { role: "status" } }),
          button(t("popupShowProblems"), () => void openSettings({ pane: "overview", logKey: null }), "small"),
        );
  replace(content, notice, commandBox, selectionBox, recentBox, footer);
  drawRecent();
  await drawSelection(tabId);
}

localizePage();
byId("open-settings").addEventListener("click", () => void openSettings());
void draw().catch((error: unknown) => {
  stateBox.className = "state problems";
  replace(stateBox, icon("warning"), errorText(error));
});
