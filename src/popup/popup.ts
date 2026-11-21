// The toolbar popup: the state of protection, block and trust for the selected
// messages, the last ten decisions (each opens its entry in the log), "Score
// selected messages" and the protection switch.

import type { CommandName } from "../core/commandNames";
import type { SenderInfo } from "../core/engine";
import { KEY_ACCESS_POINTS, KEY_ENTRIES, KEY_SETTINGS, logEntryKey } from "../core/keys";
import { findProblems, scanIsComplete } from "../core/problems";
import type { AccountFacts } from "../core/problems";
import type { AccessPoint, Entry, LogEntry, Settings } from "../core/types";
import { address, button, byId, errorText, h, replace } from "../options/dom";
import type { Child } from "../options/dom";
import { formatFullTime, formatScore, formatShortTime } from "../options/format";
import { icon } from "../options/icons";
import { recentLog } from "../options/logData";
import { loadShortcutKeys } from "../options/shortcutKeys";
import type { ShortcutKeys } from "../options/shortcutKeys";
import { localizePage, stringsLocale, t, tCode, tn } from "../tb/i18n";
import { send } from "../tb/protocol";
import type { SettingsTarget, Status } from "../tb/protocol";

const RECENT = 10;

const stateBox = byId("state");
const content = byId("content");
const selectionBox = h("section", { class: "selection" });
const recentBox = h("section", { class: "recent" });
const scoreBox = h("div", { class: "score" });
const footer = h("section", { class: "footer" });
/** What the last block or trust button did. It stays while the selection moves on to the next message. */
let commandResult: { lines: string[]; failed: boolean } | null = null;
let shortcuts: ShortcutKeys = { mac: false, keys: new Map() };

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
// Block and trust for the selected messages: the same four commands as the shortcuts.

function commandButton(label: string, name: string, command: CommandName, tabId: number, cls: string): HTMLButtonElement {
  const key = shortcuts.keys.get(command);
  const element = h(
    "button",
    { type: "button", class: cls, attrs: { "aria-label": name } },
    h("span", { text: label }),
    key === undefined ? null : h("span", { class: "key", text: key, attrs: { "aria-hidden": "true" } }),
  );
  element.addEventListener("click", () => {
    for (const other of selectionBox.querySelectorAll("button")) {
      other.disabled = true;
    }
    void (async () => {
      try {
        commandResult = await send("runCommand", { command, tabId });
      } catch (error) {
        commandResult = { lines: [errorText(error)], failed: true };
      }
      await drawSelection(tabId);
    })();
  });
  return element;
}

function resultBox(): HTMLElement | null {
  if (commandResult === null) {
    return null;
  }
  return h(
    "div",
    { class: `result ${commandResult.failed ? "error" : "ok"}`, attrs: { role: commandResult.failed ? "alert" : "status" } },
    icon(commandResult.failed ? "warning" : "success"),
    h("div", {}, ...commandResult.lines.map((line) => h("div", { text: line }))),
  );
}

async function drawSelection(tabId: number | null, quiet = false): Promise<void> {
  let count = 0;
  let sender: SenderInfo | null = null;
  if (tabId !== null) {
    try {
      ({ count, sender } = await send("selection", { tabId }));
    } catch {
      count = 0;
    }
  }
  selectionBox.hidden = false;
  if (count === 0) {
    // Right after installation the popup points at setup and nothing else.
    selectionBox.hidden = quiet && commandResult === null;
    replace(selectionBox, resultBox(), h("p", { class: "description", text: t("popupNoSelection") }));
    return;
  }
  if (tabId === null) {
    return;
  }
  const many = count > 1 || sender === null;
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
      replace(selectionBox, resultBox(), ...parts, h("p", { class: "description", text: t("popupOwnAddress") }));
      return;
    }
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
          commandButton(t("popupBlockShort"), t("popupBlockDomainNamed", domain), "block-domain", tabId, "small"),
          commandButton(t("popupTrustShort"), t("popupTrustDomainNamed", domain), "trust-domain", tabId, "small"),
        ),
      );
    } else {
      domainRow = h("p", { class: "description", text: t("popupPublicNote") });
    }
  }
  replace(
    selectionBox,
    resultBox(),
    ...parts,
    h(
      "div",
      { class: "row" },
      commandButton(t(many ? "popupBlockMany" : "popupBlock"), t(many ? "popupBlockMany" : "popupBlock"), "block-address", tabId, ""),
      commandButton(t(many ? "popupTrustMany" : "popupTrust"), t(many ? "popupTrustMany" : "popupTrust"), "trust-address", tabId, ""),
    ),
    domainRow,
  );
}

// ---------------------------------------------------------------------------
// The last decisions. Each row opens its entry in the log of the settings page.

function decisionRow(entry: LogEntry, now: number): HTMLElement {
  const sender = entry.sender === "" ? (entry.via === "" ? t("logUnknownSender") : entry.via) : entry.sender;
  // Tests and observed decisions moved nothing: they say so, and their dot is hollow.
  const marker = entry.test ? t("logTestBadge") : entry.observed ? t("logObservedBadge") : "";
  const outcome = `${tCode("outcome", entry.outcome)}${entry.score === null ? "" : ` ${formatScore(entry.score, stringsLocale())}`}${marker === "" ? "" : ` (${marker})`}`;
  const time = formatShortTime(entry.time, now);
  const row = h(
    "button",
    {
      type: "button",
      class: "decision",
      title: `${entry.subject}\n${tCode("reason", entry.reason)}\n${formatFullTime(entry.time)}`,
      attrs: { "aria-label": t("popupRowLabel", sender, outcome, time) },
    },
    h("span", { class: `dot outcome-${entry.outcome}${marker === "" ? "" : " hollow"}`, attrs: { "aria-hidden": "true" } }),
    h("span", { class: "who", text: sender }),
    h("span", { class: "what", text: outcome }),
    h("span", { class: "when", text: time }),
  );
  row.addEventListener("click", () => void openSettings({ pane: "log", logKey: logEntryKey(entry) }).catch(() => undefined));
  return h("li", {}, row);
}

function drawRecent(entries: LogEntry[]): void {
  const now = Date.now();
  replace(
    recentBox,
    h("h2", { text: t("popupRecent") }),
    entries.length === 0
      ? h("p", { class: "description", text: t("popupNoDecisions") })
      : h("ul", { class: "decisions" }, ...entries.map((entry) => decisionRow(entry, now))),
  );
}

// ---------------------------------------------------------------------------
// "Score selected messages": a test that sends the selection to the AI.

function showScoreMessage(message: string, isError = false): void {
  replace(scoreBox, h("p", { class: isError ? "result error" : "description", text: message, attrs: { role: isError ? "alert" : "status" } }), scoreButton());
}

/** Confirmation: the content of the selected messages, and how many they are, is sent to the configured AI. */
function confirmScoring(tabId: number, count: number): void {
  const send_ = button(t("popupScoreSend"), () => {
    replace(scoreBox, h("p", { class: "description", text: t("popupScoring"), attrs: { role: "status" } }));
    void (async () => {
      try {
        const summary = await send("scoreSelected", { tabId });
        showScoreMessage(summary.selected === 0 ? t("popupNothingSelected") : t("popupScoreDone", summary.scored, summary.failed), summary.selected === 0);
        drawRecent(await recentLog(RECENT));
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

function scoreButton(): HTMLButtonElement {
  return button(t("popupScoreSelected"), () => {
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

  if (!setupDone) {
    replace(
      content,
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
  replace(content, notice, selectionBox, recentBox, footer);
  drawRecent(await recentLog(RECENT));
  await drawSelection(tabId);
}

localizePage();
byId("open-settings").addEventListener("click", () => void openSettings());
void draw().catch((error: unknown) => {
  stateBox.className = "state problems";
  replace(stateBox, icon("warning"), errorText(error));
});
