// The toolbar popup: status, pause and resume, the last ten decisions, "Score
// selected messages" and a link to settings.

import { EMPTY_LOG_META, KEY_ACCESS_POINTS, KEY_LOG_META, KEY_SETTINGS, logChunkKey } from "../core/keys";
import type { LogMeta } from "../core/keys";
import type { AccessPoint, LogEntry, Settings } from "../core/types";
import { button, byId, formatScore, formatTime, h, replace } from "../options/dom";
import { localizePage, t, tCode } from "../tb/i18n";
import { send } from "../tb/protocol";
import type { Status } from "../tb/protocol";

const RECENT = 10;

const statusBox = byId("status");
const toggle = byId<HTMLButtonElement>("toggle");
const recent = byId("recent");
const scoreBox = byId("score");

async function recentDecisions(): Promise<LogEntry[]> {
  const stored = await browser.storage.local.get(KEY_LOG_META);
  const meta = (stored[KEY_LOG_META] as LogMeta | undefined) ?? EMPTY_LOG_META;
  const entries: LogEntry[] = [];
  for (let index = meta.last; index >= meta.first && entries.length < RECENT; index -= 1) {
    const key = logChunkKey(index);
    const chunk = ((await browser.storage.local.get(key))[key] as LogEntry[] | undefined) ?? [];
    entries.push(...[...chunk].reverse());
  }
  return entries.slice(0, RECENT);
}

function drawStatus(status: Status, settings: Settings | null): void {
  if (status.fatal !== null || settings === null) {
    replace(statusBox, h("span", { class: "badge bad", text: t("popupDataProblem") }));
    toggle.hidden = true;
    return;
  }
  const label = settings.protection ? (settings.observation ? t("protectionObserving") : t("protectionOn")) : t("protectionOff");
  replace(statusBox, h("span", { class: `badge ${settings.protection ? "good" : "warn"}`, text: label }));
  toggle.hidden = false;
  toggle.textContent = settings.protection ? t("popupPause") : t("popupResume");
  toggle.onclick = () => {
    toggle.disabled = true;
    void send("setProtection", { on: !settings.protection })
      .catch((error: unknown) => showScoreMessage(error instanceof Error ? error.message : String(error), true))
      .finally(() => {
        toggle.disabled = false;
        void draw();
      });
  };
}

function drawRecent(entries: LogEntry[]): void {
  if (entries.length === 0) {
    replace(recent, h("p", { class: "hint", text: t("popupNoDecisions") }));
    return;
  }
  replace(
    recent,
    h(
      "ul",
      {},
      ...entries.map((entry) =>
        h(
          "li",
          { title: `${entry.subject}\n${tCode("reason", entry.reason)}` },
          h("span", { class: `dot outcome-${entry.outcome}` }),
          h("span", { class: "sender", text: entry.sender === "" ? (entry.via === "" ? t("logUnknownSender") : entry.via) : entry.sender }),
          h("span", { class: "outcome", text: `${tCode("outcome", entry.outcome)}${entry.score === null ? "" : ` ${formatScore(entry.score)}`}` }),
          h("span", { class: "time", text: formatTime(entry.time) }),
        ),
      ),
    ),
  );
}

function showScoreMessage(message: string, isError = false): void {
  replace(scoreBox, h("p", { class: isError ? "error" : "hint", text: message }), scoreButton());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Confirmation: the content of the selected messages, and how many they are, is sent to the configured AI. */
function confirmScoring(tabId: number, count: number): void {
  replace(
    scoreBox,
    h("p", { text: t("popupScoreConfirm", count) }),
    h(
      "div",
      { class: "row" },
      button(
        t("popupScoreSend"),
        () => {
          replace(scoreBox, h("p", { class: "hint", text: t("popupScoring") }));
          void (async () => {
            try {
              const summary = await send("scoreSelected", { tabId });
              showScoreMessage(
                summary.selected === 0 ? t("popupNothingSelected") : t("popupScoreDone", summary.scored, summary.failed),
                summary.selected === 0,
              );
              await draw();
            } catch (error) {
              showScoreMessage(errorMessage(error), true);
            }
          })();
        },
        "primary",
      ),
      button(t("cancel"), () => replace(scoreBox, scoreButton())),
    ),
  );
}

function scoreButton(): HTMLButtonElement {
  return button(t("popupScoreSelected"), () => {
    void (async () => {
      try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (tab?.id === undefined) {
          showScoreMessage(t("popupNothingSelected"), true);
          return;
        }
        const { count, limit } = await send("selectedCount", { tabId: tab.id });
        if (count === 0) {
          showScoreMessage(t("popupNothingSelected"), true);
        } else if (count > limit) {
          showScoreMessage(t("popupScoreTooMany", limit), true);
        } else {
          confirmScoring(tab.id, count);
        }
      } catch (error) {
        showScoreMessage(errorMessage(error), true);
      }
    })();
  });
}

async function draw(): Promise<void> {
  const [status, stored] = await Promise.all([send("getStatus", {}), browser.storage.local.get([KEY_SETTINGS, KEY_ACCESS_POINTS])]);
  const settings = status.fatal === null ? ((stored[KEY_SETTINGS] as Settings | undefined) ?? null) : null;
  drawStatus(status, settings);
  // Stored data that failed validation is not read any further.
  drawRecent(status.fatal === null ? await recentDecisions() : []);
  const hasAi = ((stored[KEY_ACCESS_POINTS] as AccessPoint[] | undefined) ?? []).some((point) => point.enabled);
  scoreBox.hidden = status.fatal !== null;
  if (scoreBox.childElementCount === 0) {
    replace(scoreBox, hasAi ? null : h("p", { class: "hint", text: t("popupNoAi") }), scoreButton());
  }
}

localizePage();
byId("open-settings").addEventListener("click", () => {
  void browser.runtime.openOptionsPage().then(() => window.close());
});
void draw().catch((error: unknown) => {
  replace(statusBox, h("span", { class: "badge bad", text: error instanceof Error ? error.message : String(error) }));
});
