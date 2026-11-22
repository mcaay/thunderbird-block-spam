// Log: the last 5000 decisions, newest first, with filters by decision, by time and by
// account, a search, and one action per row that undoes the decision where it is seen.

import { buildPublicDomains, parseSender } from "../../core/address";
import type { LogActionOutcome, LogActionUndo } from "../../core/engine";
import { entriesFromArray } from "../../core/lists";
import type { EntryMap } from "../../core/lists";
import { logEntryKey } from "../../core/log";
import { expectsMove, fittingAction, logOffer } from "../../core/logAction";
import type { LogAction } from "../../core/logAction";
import { SCOPE_ALL } from "../../core/types";
import type { LogEntry, Outcome, Settings } from "../../core/types";
import { BUNDLED_PUBLIC_DOMAINS } from "../../data/publicDomains";
import { stringsLocale, t, tCode } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { attemptsLines } from "../diagnostic";
import { address, addressed, button, byId, dialog, errorText, guard, h, named, option, reconcile, replace, setUnavailable, tNodes } from "../dom";
import type { Child } from "../dom";
import { formatFullTime, formatScore, logTimeParts, matchesSearch, parseEntryDetail } from "../format";
import { logReader } from "../logData";
import { logLabel, logResult } from "../logLabels";
import { accountName, ownAddresses } from "../model";
import type { Model } from "../model";
import type { Intent, Section } from "../section";
import { loadShortcutKeys } from "../shortcutKeys";

const OUTCOMES: Outcome[] = ["trusted", "blocked", "spam", "passed", "no-verdict", "released", "error"];
const LOG_PAGE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The times a log is looked through by. */
const PERIODS = ["all", "today", "yesterday", "week", "month", "older"] as const;
type Period = (typeof PERIODS)[number];
/** Whether a moment falls into a period, counted in whole days back from today. */
function inPeriod(time: number, period: Period, now: number): boolean {
  if (period === "all") {
    return true;
  }
  const today = new Date(now).setHours(0, 0, 0, 0);
  const yesterday = new Date(today).setDate(new Date(today).getDate() - 1);
  switch (period) {
    case "today":
      return time >= today;
    case "yesterday":
      return time >= yesterday && time < today;
    case "week":
      return time >= today - 6 * DAY_MS;
    case "month":
      return time >= today - 29 * DAY_MS;
    default:
      return time < today - 29 * DAY_MS;
  }
}

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
  newEntryScope: (accountId: string) => string;
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
  /** Rows whose message was looked for and is gone. */
  const gone = new Set<string>();

  const undoHint = h("span");
  const filter = h(
    "select",
    {
      id: "log-filter",
      // The label next to it says "Show:". The name says what is shown.
      attrs: { "aria-label": t("logFilterName") },
      onchange: () => {
        limit = LOG_PAGE;
        highlighted = null;
        draw();
      },
    },
    option("all", t("logAll")),
    ...OUTCOMES.map((outcome) => option(outcome, tCode("outcome", outcome))),
    option("tests", t("logTests")),
    option("observed", t("logObserved")),
  );
  const refilter = (): void => {
    limit = LOG_PAGE;
    highlighted = null;
    draw();
  };
  const period = h(
    "select",
    { id: "log-period", onchange: refilter, attrs: { "aria-label": t("logPeriodLabel") } },
    ...PERIODS.map((name) => option(name, tCode("period", name))),
  );
  /** With several accounts the log can be narrowed to one of them. */
  const account = h("select", { id: "log-account", hidden: true, onchange: refilter, attrs: { "aria-label": t("logAccountLabel") } });
  const search = h("input", {
    type: "search",
    id: "log-search",
    placeholder: t("logSearch"),
    attrs: { "aria-label": t("logSearchLabel") },
    oninput: () => {
      limit = LOG_PAGE;
      highlighted = null;
      draw();
    },
  });
  const rows = h("tbody", { attrs: { role: "rowgroup" } });
  const more = h("div", { class: "row" });
  /** How many entries are shown, or how many match the filter and the search, out of how many. */
  const summary = h("p", { class: "description count-line", attrs: { role: "status" } });
  // Nothing to clear in an empty log: the button is unavailable until there is.
  const clear = button(t("logClear"), () =>
    void dialog({
      title: t("logClearTitle"),
      body: [t("logClearText")],
      confirmLabel: t("logClearConfirm"),
      danger: true,
      onConfirm: async () => {
        await send("clearLog", {});
        results.clear();
        gone.clear();
      },
    }),
  );
  // Unavailable, not disabled: the dialog gives the focus back to this button after the log was cleared.
  setUnavailable(clear, true);
  const header = (label: string, cls: string): HTMLElement => h("th", { text: label, class: cls, attrs: { role: "columnheader", scope: "col" } });

  replace(
    root,
    h("h1", { text: t("catLog"), tabIndex: -1 }),
    h("p", { class: "lead", text: t("logHint") }),
    h("div", { class: "description" }, undoHint),
    h(
      "div",
      { class: "row filters" },
      h("label", { for: "log-filter", text: t("logFilterLabel") }),
      filter,
      period,
      account,
      // The search field and the button move to the next line together when the row is too narrow for both.
      h("div", { class: "search-group" }, search, clear),
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

  /**
   * What stands under the outcome. A decision of the lists names the entry that
   * decided in one line. A decision of the AI gives the reason and, when the sender was
   * added to the black list, the entry. The scope is said only for an entry that is
   * limited to one account. Who scored stands under the score.
   */
  function detailLines(entry: LogEntry): string[] {
    const reason = tCode("reason", entry.reason);
    const listed = parseEntryDetail(entry.detail);
    if (listed === null) {
      return entry.detail === "" ? [reason] : [reason, ...attemptsLines(entry.detail)];
    }
    const only = listed.scope === SCOPE_ALL || model === null ? null : t("scopeOnlyAccount", accountName(model, listed.scope));
    if (entry.reason === "ai-above") {
      const added =
        only === null
          ? t(entry.observed ? "logWouldAdd" : "logAdded", listed.value)
          : t(entry.observed ? "logWouldAddScoped" : "logAddedScoped", listed.value, only);
      return [reason, added];
    }
    const white = entry.outcome === "trusted" || entry.outcome === "released";
    return [only === null ? t(white ? "logWhiteEntry" : "logBlackEntry", listed.value) : t(white ? "logWhiteEntryScoped" : "logBlackEntryScoped", listed.value, only)];
  }

  function outcomeText(outcome: LogActionOutcome): string {
    const white = outcome.list === "white";
    // The line names exactly what changed on the lists: the entry that was added, moved or removed.
    const said = logResult(outcome);
    const parts = [tCode("logResult", said.code, ...said.args)];
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
    /** The accessible name: the label and what it acts on. */
    name: string;
    action: LogAction | null;
  }

  /** The one action that fits a row, given the decision and the lists as they are now. Its label names exactly what it changes. */
  function offer(entry: LogEntry): Offer | null {
    const fitting = fittingAction(entry);
    const sender = parseSender(entry.sender);
    if (fitting === null || sender === null || lists === null || lists.own.has(sender.address)) {
      return null;
    }
    const offered = logOffer(lists, entry, fitting);
    if (offered === null) {
      return null;
    }
    const said = logLabel(offered, expectsMove(entry, fitting));
    const label = tCode("logLabel", said.label);
    // An action that changes the lists is named by the entry it changes, one that only moves the message by the message.
    const object = offered.change === "none" ? (entry.subject === "" ? t("logNoSubject") : entry.subject) : offered.target.value;
    return { label, title: tCode("logTitle", said.title, ...said.titleArgs), name: t("labelNamed", label, object), action: said.acts ? fitting : null };
  }

  /**
   * What a row offers and what its last action did. The button stands at the end of
   * the row. The result of an action is said in the row itself, under the decision it
   * changed, and Undo takes the place of the button that was pressed.
   */
  function rowControls(entry: LogEntry, key: string, current: Offer | null): { control: Child; feedback: Child } {
    const result = results.get(key);
    const working = busy.has(key);
    const text = result === undefined ? null : h("span", { attrs: { role: result.kind === "error" ? "alert" : "status" } }, ...addressed(result.text));
    if (result !== undefined && result.undo !== null) {
      const data = result.undo;
      const undoButton = setUnavailable(button(t("undo"), () => undo(key, data), "small"), working);
      // Every row can have one: the name says whose decision is put back.
      named(undoButton, entry.sender);
      undoButton.dataset.focus = "act";
      return { control: undoButton, feedback: h("div", { class: `row-feedback ${result.kind}` }, text) };
    }
    const feedback =
      result !== undefined
        ? h("div", { class: `row-feedback ${result.kind}` }, text)
        : gone.has(key)
          ? // Where the results of actions stand: the message of this row was looked for and is gone.
            h("div", { class: "row-feedback plain" }, h("span", { text: t("logMessageGone"), attrs: { role: "status" } }))
          : null;
    if (current === null) {
      return { control: null, feedback };
    }
    const action = current.action;
    if (action === null) {
      return { control: h("span", { class: "row-note", text: current.label, title: current.title }), feedback };
    }
    const actButton = setUnavailable(button(current.label, () => act(entry, key, action), "small"), working);
    actButton.title = current.title;
    // The name is the label and its object. The whole sentence is the tooltip, so that a screen reader does not say it twice.
    actButton.setAttribute("aria-label", current.name);
    actButton.dataset.focus = "act";
    return { control: actButton, feedback };
  }

  /** Opens the message of a row in a tab, so that the decision can be judged against the message itself. */
  function showMessage(entry: LogEntry, key: string): void {
    void guard(async () => {
      const { found } = await send("showMessage", { accountId: entry.accountId, messageId: entry.messageId });
      if (!found) {
        gone.add(key);
        draw();
      }
    });
  }

  function messageLink(entry: LogEntry, key: string): Child {
    // A message that was looked for and is gone has no link any more: the row says so under its decision.
    if (entry.messageId === "" || gone.has(key)) {
      return null;
    }
    const link = button(t("logShowMessage"), () => showMessage(entry, key), "link show-message");
    link.dataset.focus = "show";
    link.setAttribute("aria-label", t("logShowMessageNamed", entry.subject === "" ? t("logNoSubject") : entry.subject));
    return link;
  }

  function row(entry: LogEntry, key: string, current: Offer | null, now: number): HTMLElement {
    const score = entry.score === null ? "" : formatScore(entry.score, stringsLocale());
    const subject = entry.subject === "" ? t("logNoSubject") : entry.subject;
    const sender = entry.sender === "" ? t("logUnknownSender") : entry.sender;
    const actionText = entry.action === "none" ? "" : entry.observed ? tCode("actionObserved", entry.action) : tCode("action", entry.action);
    // A badge never stands alone on a line: it stays with the word of the decision.
    const badges: Child[] = [];
    if (entry.observed) {
      badges.push(" ", h("span", { class: "badge", text: t("logObservedBadge") }));
    }
    if (entry.test) {
      badges.push(" ", h("span", { class: "badge", text: t("logTestBadge") }));
    }
    const outcomeLabel = h("span", { class: `outcome outcome-${entry.outcome}`, text: tCode("outcome", entry.outcome) });
    // The decision in one word, with its badges, and under it what was done about the message. Two short lines that
    // fit their column in every language, instead of one long line that wraps where it happens to run out.
    const outcomeParts: Child[] = [h("span", { class: "keep outcome-head" }, outcomeLabel, ...badges)];
    const showAccount = (model?.accounts.length ?? 0) > 1;
    const cell = (cls: string, ...children: Child[]): HTMLElement => h("td", { class: cls, attrs: { role: "cell" } }, ...children);
    const controls = rowControls(entry, key, current);
    const when = logTimeParts(entry.time, now);
    return h(
      "tr",
      { class: key === highlighted ? "highlight" : "", tabIndex: -1, attrs: { role: "row" } },
      cell(
        "col-time",
        // The date of another day stands above the time, so the column is as wide as the longer of the two.
        h(
          "span",
          { class: "when", title: formatFullTime(entry.time) },
          when.date === null ? null : h("span", { class: "date", text: when.date }),
          when.date === null ? null : " ",
          h("span", { class: "clock", text: when.clock }),
        ),
      ),
      cell(
        "col-message",
        h(
          "div",
          { class: "sender" },
          entry.sender === "" ? sender : address(sender),
          entry.via === "" ? null : h("span", { class: "via" }, " ", t("logForwardedBy"), " ", address(entry.via)),
        ),
        // Up to two lines: a longer subject is cut, and the tooltip has all of it.
        // A subject can name an address or a domain: there it breaks like one.
        h("div", { class: "subject", title: subject }, ...addressed(subject)),
        // With several accounts, the account has a line of its own under the subject, where its whole name has room.
        showAccount ? h("div", { class: "account description" }, ...addressed(entry.account)) : null,
      ),
      cell(
        "col-outcome",
        h(
          "div",
          { class: "outcome-line" },
          ...outcomeParts,
          entry.score === null
            ? null
            : h("span", { class: "score-inline", text: entry.accessPoint === "" ? score : `${score} (${entry.accessPoint})`, title: t("logScoreTitle", score) }),
          actionText === "" ? null : h("div", { class: "outcome-done", text: actionText }),
        ),
        // An entry of a list is named by its address or domain, which breaks like one.
        ...detailLines(entry).map((line) => h("div", { class: "detail description" }, ...addressed(line))),
        controls.feedback,
      ),
      cell(
        "col-score",
        entry.score === null ? null : h("span", { text: score, title: t("logScoreTitle", score) }),
        // Who scored, under the number. A long name wraps, and the tooltip has all of it.
        entry.score === null || entry.accessPoint === "" ? null : h("div", { class: "scorer description", title: t("logScoredBy", entry.accessPoint) }, ...addressed(entry.accessPoint)),
      ),
      // What can be done with the row: the action that undoes the decision, and under it the way to the message itself.
      cell("col-action", controls.control, h("div", { class: "show-message-line" }, messageLink(entry, key))),
    );
  }

  function draw(): void {
    const now = Date.now();
    const today = new Date(now).toDateString();
    const needle = search.value.trim();
    const when = period.value as Period;
    // The menu of accounts is there with more than one account. An account that is chosen stays chosen while it exists.
    const accounts = model?.accounts ?? [];
    const accountsSignature = JSON.stringify(accounts.map((item) => [item.id, item.name]));
    if (account.dataset.signature !== accountsSignature) {
      const chosen = account.value;
      account.dataset.signature = accountsSignature;
      replace(account, option("all", t("scopeAll"), chosen === "all" || chosen === ""), ...accounts.map((item) => option(item.id, item.name, chosen === item.id)));
      account.hidden = accounts.length < 2;
    }
    const where = account.hidden ? "all" : account.value;
    // The whole name of the chosen account, for when the menu is too narrow for it.
    account.title = where === "all" ? "" : (account.selectedOptions[0]?.textContent ?? "");
    const matching = entries.filter(
      (entry) =>
        inPeriod(entry.time, when, now) &&
        (where === "all" || entry.accountId === where) &&
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
    // Without a filter the line counts the rows, with one it counts what matches. The button under the table offers the rest.
    const filtered = filter.value !== "all" || when !== "all" || where !== "all" || needle !== "";
    const count = entries.length === 0 ? "" : filtered ? t("matchCount", matching.length, entries.length) : t("logCount", Math.min(matching.length, limit), entries.length);
    // An empty log says why it is empty when protection is not on yet.
    const emptyText =
      entries.length > 0
        ? t("logNoMatch")
        : model?.status.wish.waiting === true
          ? t("logEmptyWaiting")
          : model?.settings?.protection === false
            ? t("logEmptyOff")
            : t("logEmpty");
    if (summary.textContent !== count) {
      summary.textContent = count;
    }
    summary.hidden = entries.length === 0;
    setUnavailable(clear, entries.length === 0);
    reconcile(
      rows,
      matching.length === 0
        ? [
            {
              key: "empty",
              signature: emptyText,
              build: () => h("tr", { class: "empty-row", attrs: { role: "row" } }, h("td", { colSpan: 5, class: "empty", text: emptyText, attrs: { role: "cell" } })),
            },
          ]
        : matching.slice(0, limit).map((entry) => {
            const key = logEntryKey(entry);
            const current = offer(entry);
            return {
              key,
              signature: JSON.stringify([current, results.get(key) ?? null, busy.has(key), gone.has(key), key === highlighted, today, model?.accounts.length ?? 0]),
              build: () => row(entry, key, current, now),
            };
          }),
    );
    replace(
      more,
      matching.length > limit
        ? button(t("showMore", Math.min(LOG_PAGE, matching.length - limit), matching.length - limit), () => {
            const first = limit;
            limit += LOG_PAGE;
            draw();
            // The button was drawn anew, or is gone with the last rows: the keyboard stays on it, or goes on with the first new row.
            (more.querySelector("button") ?? rows.querySelectorAll<HTMLElement>("tr")[first])?.focus();
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
    const block = keys.get("block-address");
    // Which key undoes a decision depends on the decision: one trusts the sender, the other blocks it.
    replace(undoHint, ...(trust === undefined || block === undefined ? [t("logUndoHint")] : tNodes("logUndoHintKey", h("kbd", { text: trust }), h("kbd", { text: block }))));
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
      const scopeSetting: Settings["newEntryScope"] = settings.newEntryScope;
      lists = {
        entries: entriesFromArray(next.entries),
        publicDomains: buildPublicDomains(BUNDLED_PUBLIC_DOMAINS, settings.publicDomainsAdded, settings.publicDomainsRemoved),
        own: ownAddresses(next),
        newEntryScope: (accountId) => (scopeSetting === "shared" ? SCOPE_ALL : accountId),
      };
      void guard(load);
    },
    reveal(intent: Intent) {
      if (intent.kind !== "log-entry") {
        return;
      }
      // The entry has to be among the rows: no filter, no search.
      filter.value = "all";
      period.value = "all";
      account.value = "all";
      search.value = "";
      wanted = intent.key;
      highlighted = intent.key;
      void guard(load);
    },
    leave() {
      // The mark of the entry the popup pointed at lasts for this visit of the pane.
      if (highlighted !== null) {
        highlighted = null;
        draw();
      }
    },
  };
}
