// Log: the last 5000 decisions with a filter, a search, and one action per row that
// undoes the decision where it is seen.

import { buildPublicDomains, parseSender } from "../../core/address";
import type { LogActionOutcome, LogActionUndo } from "../../core/engine";
import { entriesFromArray, matchSender } from "../../core/lists";
import type { EntryMap } from "../../core/lists";
import { logEntryKey } from "../../core/log";
import { expectsMove, fittingAction, logActionTarget } from "../../core/logAction";
import type { LogAction } from "../../core/logAction";
import { SCOPE_ALL } from "../../core/types";
import type { LogEntry, Outcome } from "../../core/types";
import { BUNDLED_PUBLIC_DOMAINS } from "../../data/publicDomains";
import { stringsLocale, t, tCode } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { address, button, byId, dialog, errorText, guard, h, option, reconcile, replace, setUnavailable } from "../dom";
import type { Child } from "../dom";
import { formatFullTime, formatLogTime, formatScore, matchesSearch, parseEntryDetail } from "../format";
import { logReader } from "../logData";
import { accountName, ownAddresses } from "../model";
import type { Model } from "../model";
import type { Intent, Section } from "../section";
import { loadShortcutKeys } from "../shortcutKeys";

const OUTCOMES: Outcome[] = ["trusted", "blocked", "spam", "passed", "no-verdict", "released", "error"];
const LOG_PAGE = 100;

/** What an action of this session did to a row. */
interface RowResult {
  text: string;
  kind: "ok" | "error";
  /** Set while the action can still be taken back. */
  undo: LogActionUndo | null;
}

/** The lists as the page sees them, for telling what an action would add. */
interface Lists {
  entries: EntryMap;
  publicDomains: Set<string>;
  own: Set<string>;
}

export function logSection(): Section {
  const root = byId("log");
  let model: Model | null = null;
  let lists: Lists | null = null;
  let entries: LogEntry[] = [];
  let limit = LOG_PAGE;
  /** The entry the popup asked for. It is scrolled into view and marked once it is drawn. */
  let wanted: string | null = null;
  let highlighted: string | null = null;
  const results = new Map<string, RowResult>();
  const busy = new Set<string>();

  const undoHint = h("span");
  const filter = h(
    "select",
    {
      id: "log-filter",
      onchange: () => {
        limit = LOG_PAGE;
        draw();
      },
    },
    option("all", t("logAll")),
    ...OUTCOMES.map((outcome) => option(outcome, tCode("outcome", outcome))),
    option("tests", t("logTests")),
    option("observed", t("logObserved")),
  );
  const search = h("input", {
    type: "search",
    id: "log-search",
    placeholder: t("logSearch"),
    attrs: { "aria-label": t("logSearchLabel") },
    oninput: () => {
      limit = LOG_PAGE;
      draw();
    },
  });
  const rows = h("tbody", { attrs: { role: "rowgroup" } });
  const more = h("div", { class: "row" });
  const summary = h("p", { class: "description" });
  const header = (label: string, cls: string): HTMLElement => h("th", { text: label, class: cls, attrs: { role: "columnheader", scope: "col" } });

  replace(
    root,
    h("h1", { text: t("catLog"), tabIndex: -1 }),
    h("div", { class: "description" }, t("logHint"), " ", undoHint),
    h(
      "div",
      { class: "row filters" },
      h("label", { for: "log-filter", text: t("logFilterLabel") }),
      filter,
      search,
      button(t("logClear"), () =>
        void dialog({
          title: t("logClearTitle"),
          body: [t("logClearText")],
          confirmLabel: t("logClearConfirm"),
          danger: true,
          onConfirm: async () => {
            await send("clearLog", {});
            results.clear();
          },
        }),
      ),
    ),
    summary,
    h(
      "table",
      { class: "log", attrs: { role: "table" } },
      h(
        "thead",
        { attrs: { role: "rowgroup" } },
        h(
          "tr",
          { attrs: { role: "row" } },
          header(t("colTime"), "col-time"),
          header(t("colMessage"), "col-message"),
          header(t("colOutcome"), "col-outcome"),
          header(t("colScore"), "col-score"),
          h("th", { class: "col-action", attrs: { role: "columnheader", scope: "col" } }, h("span", { class: "visually-hidden", text: t("colActions") })),
        ),
      ),
      rows,
    ),
    more,
  );

  function scopeText(scope: string): string {
    return scope === SCOPE_ALL || model === null ? t("scopeAllLower") : t("scopeOnlyAccount", accountName(model, scope));
  }

  /** The lines under the reason: what was added to a list, the entry that decided, who scored. */
  function detailLines(entry: LogEntry): string[] {
    const lines: string[] = [];
    const listed = parseEntryDetail(entry.detail);
    if (listed !== null) {
      lines.push(
        t(entry.reason === "ai-above" ? (entry.observed ? "logWouldAdd" : "logAdded") : "logEntryLine", listed.value, scopeText(listed.scope)),
      );
    } else if (entry.detail !== "") {
      lines.push(entry.detail);
    }
    if (entry.accessPoint !== "") {
      lines.push(t("logScoredBy", entry.accessPoint));
    }
    return lines;
  }

  function outcomeText(outcome: LogActionOutcome): string {
    const white = outcome.list === "white";
    const value = outcome.target.value;
    const parts = [
      outcome.result === "unchanged"
        ? t(white ? "logAlreadyTrusted" : "logAlreadyBlocked", value)
        : t(white ? "logDoneTrusted" : "logDoneBlocked", value),
    ];
    if (outcome.move === "moved") {
      parts.push(t(white ? "logMovedInbox" : "logMovedJunk"));
    } else if (outcome.move === "not-found") {
      parts.push(t("logMoveNotFound"));
    } else if (outcome.move === "no-folder") {
      parts.push(t(white ? "logMoveNoInbox" : "logMoveNoJunk"));
    } else if (outcome.move === "failed") {
      parts.push(t("logMoveFailed", outcome.failure));
    }
    return parts.join(" ");
  }

  function act(entry: LogEntry, key: string, action: LogAction): void {
    busy.add(key);
    draw();
    void (async () => {
      try {
        const outcome = await send("logAction", { entry, action });
        const undoable = outcome.undo.remove.length > 0 || outcome.undo.restore.length > 0 || outcome.undo.move !== null;
        results.set(key, { text: outcomeText(outcome), kind: outcome.move === "failed" ? "error" : "ok", undo: undoable ? outcome.undo : null });
      } catch (error) {
        results.set(key, { text: errorText(error), kind: "error", undo: null });
      }
      busy.delete(key);
      draw();
    })();
  }

  function undo(key: string, data: LogActionUndo): void {
    busy.add(key);
    draw();
    void (async () => {
      try {
        const outcome = await send("undoLogAction", { undo: data });
        results.set(key, {
          text:
            outcome.move === "failed"
              ? `${t("logUndone")} ${t("logMoveFailed", outcome.failure)}`
              : outcome.move === "not-found"
                ? `${t("logUndone")} ${t("logMoveNotFound")}`
                : t("logUndone"),
          kind: outcome.move === "failed" ? "error" : "ok",
          undo: null,
        });
      } catch (error) {
        results.set(key, { text: errorText(error), kind: "error", undo: null });
      }
      busy.delete(key);
      draw();
    })();
  }

  interface Offer {
    /** What the cell shows: a button for an action, or a note that nothing is left to do. */
    label: string;
    title: string;
    action: LogAction | null;
  }

  /** The one action that fits a row, given the decision and the lists as they are now. */
  function offer(entry: LogEntry): Offer | null {
    const fitting = fittingAction(entry);
    const sender = parseSender(entry.sender);
    if (fitting === null || sender === null || lists === null || lists.own.has(sender.address)) {
      return null;
    }
    const deciding = matchSender(lists.entries, sender, entry.accountId);
    const target = logActionTarget(lists, entry, fitting);
    if (target === null) {
      return null;
    }
    if (fitting === "trust") {
      const moves = expectsMove(entry, "trust");
      if (deciding?.list === "white") {
        // Already trusted: only the message may still be where the decision put it.
        return moves
          ? { label: t("logMoveInbox"), title: t("logMoveInboxTitle", deciding.value), action: "trust" }
          : { label: t("logTrustedNow"), title: t("logTrustedNowTitle", deciding.value), action: null };
      }
      return { label: t("logTrust"), title: t(moves ? "logTrustMoveTitle" : "logTrustTitle", target.value), action: "trust" };
    }
    if (deciding?.list === "black") {
      return { label: t("logMoveJunk"), title: t("logMoveJunkTitle", deciding.value), action: "block" };
    }
    return { label: t("logBlock"), title: t("logBlockTitle", target.value), action: "block" };
  }

  /**
   * What a row offers and what its last action did. The button stands at the end of
   * the row. The result of an action is said in the row itself, under the decision it
   * changed, together with Undo.
   */
  function rowControls(entry: LogEntry, key: string, current: Offer | null): { control: Child; feedback: Child } {
    const result = results.get(key);
    const working = busy.has(key);
    const text = result === undefined ? null : h("span", { text: result.text, attrs: { role: result.kind === "error" ? "alert" : "status" } });
    if (result !== undefined && result.undo !== null) {
      const data = result.undo;
      const undoButton = setUnavailable(button(t("undo"), () => undo(key, data), "small"), working);
      undoButton.dataset.focus = "act";
      return { control: null, feedback: h("div", { class: `row-feedback ${result.kind}` }, text, undoButton) };
    }
    const feedback = result === undefined ? null : h("div", { class: `row-feedback ${result.kind}` }, text);
    if (current === null) {
      return { control: null, feedback };
    }
    const action = current.action;
    if (action === null) {
      return { control: h("span", { class: "row-note", text: current.label, title: current.title }), feedback };
    }
    const actButton = setUnavailable(button(current.label, () => act(entry, key, action), "small outline"), working);
    actButton.title = current.title;
    actButton.setAttribute("aria-label", current.title);
    actButton.dataset.focus = "act";
    return { control: actButton, feedback };
  }

  function row(entry: LogEntry, key: string, current: Offer | null, now: number): HTMLElement {
    const sender = entry.sender === "" ? t("logUnknownSender") : entry.sender;
    const actionText = entry.action === "none" ? "" : entry.observed ? tCode("actionObserved", entry.action) : tCode("action", entry.action);
    const showAccount = (model?.accounts.length ?? 0) > 1;
    const cell = (cls: string, ...children: Child[]): HTMLElement => h("td", { class: cls, attrs: { role: "cell" } }, ...children);
    const controls = rowControls(entry, key, current);
    return h(
      "tr",
      { class: key === highlighted ? "highlight" : "", tabIndex: -1, attrs: { role: "row" } },
      cell("col-time", h("span", { text: formatLogTime(entry.time, now), title: formatFullTime(entry.time) })),
      cell(
        "col-message",
        h(
          "div",
          { class: "sender" },
          entry.sender === "" ? sender : address(sender),
          entry.via === "" ? null : h("span", { class: "via" }, " ", t("logForwardedBy"), " ", address(entry.via)),
        ),
        h("div", { class: "subject", text: entry.subject === "" ? t("logNoSubject") : entry.subject }),
        showAccount ? h("div", { class: "account description", text: entry.account }) : null,
      ),
      cell(
        "col-outcome",
        h(
          "div",
          { class: "outcome-line" },
          h("span", { class: `outcome outcome-${entry.outcome}`, text: tCode("outcome", entry.outcome) }),
          actionText === "" ? null : h("span", { class: "outcome-action", text: `, ${actionText}` }),
          entry.observed ? h("span", { class: "badge", text: t("logObservedBadge") }) : null,
          entry.test ? h("span", { class: "badge", text: t("logTestBadge") }) : null,
          entry.score === null ? null : h("span", { class: "score-inline", text: formatScore(entry.score, stringsLocale()), title: t("logScoreTitle", formatScore(entry.score, stringsLocale())) }),
        ),
        h("div", { class: "reason description", text: tCode("reason", entry.reason) }),
        ...detailLines(entry).map((line) => h("div", { class: "detail description", text: line })),
        controls.feedback,
      ),
      cell("col-score", entry.score === null ? null : h("span", { text: formatScore(entry.score, stringsLocale()), title: t("logScoreTitle", formatScore(entry.score, stringsLocale())) })),
      cell("col-action", controls.control),
    );
  }

  function draw(): void {
    const now = Date.now();
    const today = new Date(now).toDateString();
    const needle = search.value.trim();
    const matching = entries.filter(
      (entry) =>
        (filter.value === "all"
          ? true
          : filter.value === "tests"
            ? entry.test
            : filter.value === "observed"
              ? entry.observed
              : entry.outcome === filter.value) &&
        (needle === "" || matchesSearch(needle, entry.sender, entry.via, entry.subject)),
    );
    if (wanted !== null) {
      const index = matching.findIndex((entry) => logEntryKey(entry) === wanted);
      if (index >= limit) {
        limit = (Math.floor(index / LOG_PAGE) + 1) * LOG_PAGE;
      }
    }
    summary.textContent = entries.length === 0 ? "" : t("logCount", Math.min(matching.length, limit), matching.length);
    summary.hidden = entries.length === 0;
    reconcile(
      rows,
      matching.length === 0
        ? [
            {
              key: "empty",
              signature: String(entries.length === 0),
              build: () =>
                h(
                  "tr",
                  { class: "empty-row", attrs: { role: "row" } },
                  h("td", { colSpan: 5, class: "empty", text: t(entries.length === 0 ? "logEmpty" : "logNoMatch"), attrs: { role: "cell" } }),
                ),
            },
          ]
        : matching.slice(0, limit).map((entry) => {
            const key = logEntryKey(entry);
            const current = offer(entry);
            return {
              key,
              signature: JSON.stringify([current, results.get(key) ?? null, busy.has(key), key === highlighted, today, model?.accounts.length ?? 0]),
              build: () => row(entry, key, current, now),
            };
          }),
    );
    replace(
      more,
      matching.length > limit
        ? button(t("showMore", matching.length - limit), () => {
            limit += LOG_PAGE;
            draw();
          })
        : null,
    );
    if (wanted !== null) {
      const target = [...rows.querySelectorAll<HTMLElement>("tr")].find((candidate) => candidate.dataset.key === wanted);
      if (target !== undefined) {
        wanted = null;
        target.scrollIntoView({ block: "center" });
        target.focus({ preventScroll: true });
      }
    }
  }

  async function load(): Promise<void> {
    entries = (await logReader.load()).entries;
    draw();
  }

  async function drawUndoHint(): Promise<void> {
    const { keys } = await loadShortcutKeys();
    const trust = keys.get("trust-address");
    undoHint.textContent = trust === undefined ? t("logUndoHint") : t("logUndoHintKey", trust);
  }

  undoHint.textContent = t("logUndoHint");
  browser.commands.onChanged.addListener(() => void guard(drawUndoHint));
  void guard(drawUndoHint);

  return {
    render(next: Model) {
      model = next;
      const settings = next.settings;
      // Stored data that failed validation is not read any further.
      if (next.status.fatal !== null || settings === null) {
        return;
      }
      lists = {
        entries: entriesFromArray(next.entries),
        publicDomains: buildPublicDomains(BUNDLED_PUBLIC_DOMAINS, settings.publicDomainsAdded, settings.publicDomainsRemoved),
        own: ownAddresses(next),
      };
      void guard(load);
    },
    reveal(intent: Intent) {
      if (intent.kind !== "log-entry") {
        return;
      }
      // The entry has to be among the rows: no filter, no search.
      filter.value = "all";
      search.value = "";
      wanted = intent.key;
      highlighted = intent.key;
      void guard(load);
    },
  };
}
