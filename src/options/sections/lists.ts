// Lists: the white list and the black list with add and remove, the scope of entries
// the add-on creates by itself, and the table of all entries: filters by list and by
// source, a search, and a sort by every column.

import { keyOf } from "../../core/lists";
import { SCOPE_ALL } from "../../core/types";
import type { Entry, EntrySource, Settings } from "../../core/types";
import { stringsLocale, t, tCode, tn } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import {
  address,
  button,
  byId,
  description,
  errorText,
  fieldError,
  focusNeighbor,
  guard,
  h,
  inlineStatus,
  learnMore,
  notice,
  option,
  reconcile,
  removeButton,
  replace,
} from "../dom";
import { formatDate, formatFullTime } from "../format";
import { accountName } from "../model";
import type { Model } from "../model";
import type { Section } from "../section";

const PAGE = 200;
const SOURCES: EntrySource[] = ["identity", "sent", "scan", "ai", "manual"];

/** The columns the table sorts by. */
type SortKey = "value" | "list" | "scope" | "source" | "date";

export function listsSection(): Section {
  const root = byId("lists");
  let model: Model | null = null;
  let limit = PAGE;
  /** The column the table is sorted by, and its direction. Newest first until a header is pressed. */
  let sort: { key: SortKey; descending: boolean } = { key: "date", descending: true };
  /** What the last removal did, with Undo. It stands between the filter and the table. */
  const removed = notice();

  const counts = h("p", { class: "counts" });
  const filter = h(
    "select",
    { id: "entries-filter", onchange: () => reset() },
    option("all", t("listsBoth")),
    option("white", t("listWhite")),
    option("black", t("listBlack")),
  );
  const source = h(
    "select",
    { id: "entries-source", onchange: () => reset() },
    option("all", t("listsAllSources")),
    ...SOURCES.map((name) => option(name, tCode("source", name))),
  );
  const search = h("input", {
    type: "search",
    id: "entries-search",
    placeholder: t("listsSearch"),
    oninput: () => reset(),
    attrs: { "aria-label": t("listsSearchLabel") },
  });
  const rows = h("tbody");
  const more = h("div", { class: "row" });
  /** How many entries are shown, or how many match the filter and the search, out of how many. */
  const summary = h("p", { class: "description count-line", attrs: { role: "status" } });

  const addValue = h("input", {
    type: "text",
    id: "entry-value",
    placeholder: t("listsValuePlaceholder"),
    oninput: () => {
      valueError.set(null);
      addStatus.clear();
      // Nothing can be added before something is typed: the button says so by being unavailable.
      addButton.disabled = addValue.value.trim() === "";
    },
    attrs: { autocomplete: "off", spellcheck: "false" },
  });
  const valueError = fieldError(addValue, "entry-value-error");
  const addList = h("select", { id: "entry-list" }, option("white", t("listWhite")), option("black", t("listBlack")));
  const addScope = h("select", { id: "entry-scope" });
  const addStatus = inlineStatus();
  const addButton = h("button", { type: "submit", text: t("add"), disabled: true });
  const addForm = h(
    "form",
    {
      class: "add-entry",
      attrs: { novalidate: "" },
      onsubmit: (event) => {
        event.preventDefault();
        if (addValue.value.trim() === "") {
          valueError.set(tCode("invalid", "entry-invalid"));
          addValue.focus();
          return;
        }
        removed.clear();
        void (async () => {
          try {
            const reply = await send("addEntry", { list: addList.value, value: addValue.value, scope: addScope.value });
            valueError.set(null);
            addValue.value = "";
            addButton.disabled = true;
            const white = reply.list === "white";
            addStatus.set(
              reply.result === "added"
                ? t(white ? "listsAddedWhite" : "listsAddedBlack", reply.value)
                : reply.result === "moved"
                  ? t(white ? "listsMovedWhite" : "listsMovedBlack", reply.value)
                  : t("listsAlreadyThere", reply.value),
              "ok",
            );
          } catch (error) {
            // The error stays under the field, and the focus in it.
            valueError.set(errorText(error));
            addStatus.clear();
          }
          addValue.focus();
        })();
      },
    },
    h("div", { class: "field grow" }, h("label", { for: "entry-value", text: t("listsValueLabel") }), addValue),
    h("div", { class: "field" }, h("label", { for: "entry-list", text: t("listsListLabel") }), addList),
    h("div", { class: "field" }, h("label", { for: "entry-scope", text: t("listsScopeLabel") }), addScope),
    addButton,
  );

  /**
   * A column header that sorts the table: the first press sorts by its column, the second reverses the order.
   * It looks like the header it is, with an arrow while its column gives the order, as in Thunderbird's own tables.
   */
  const headers = new Map<SortKey, HTMLTableCellElement>();
  function sortHeader(key: SortKey, label: string): HTMLTableCellElement {
    const press = button(
      label,
      () => {
        // Text reads from A to Z first, dates from the newest.
        sort = sort.key === key ? { key, descending: !sort.descending } : { key, descending: key === "date" };
        limit = PAGE;
        draw();
      },
      "sort",
    );
    press.title = t("sortBy", label);
    const cell = h("th", { attrs: { scope: "col" } }, press);
    headers.set(key, cell);
    return cell;
  }

  /** Said while Thunderbird has fewer than two accounts: the choice then makes no difference yet. */
  const sharingNote = description(t("newEntriesSingle"));

  const newScope = h(
    "select",
    {
      id: "new-scope",
      onchange: () => void guard(() => send("updateSettings", { patch: { newEntryScope: newScope.value as Settings["newEntryScope"] } })),
    },
    option("shared", t("scopeShared")),
    option("account", t("scopePerAccount")),
  );

  replace(
    root,
    h("h1", { text: t("catLists"), tabIndex: -1 }),
    h("p", { class: "lead" }, t("listsHint"), " ", learnMore(t("catLists"), t("listsMore"))),
    counts,
    h("h2", { text: t("listsAddTitle") }),
    addForm,
    valueError.element,
    addStatus.element,
    // What applies to every future entry stands before the table, which can be hundreds of rows long.
    h("h2", { text: t("newEntriesTitle") }),
    h("div", { class: "row" }, h("label", { for: "new-scope", text: t("newEntriesLabel") }), newScope),
    description(t("newEntriesHint")),
    sharingNote,
    h("h2", { text: t("listsEntriesTitle") }),
    h(
      "div",
      { class: "row filters" },
      h("label", { for: "entries-filter", text: t("listsFilterLabel") }),
      filter,
      h("label", { for: "entries-source", text: t("listsSourceLabel") }),
      source,
      search,
    ),
    summary,
    removed.element,
    h(
      "table",
      { class: "entries" },
      h(
        "colgroup",
        {},
        h("col", {}),
        h("col", { class: "col-list" }),
        h("col", { class: "col-scope" }),
        h("col", { class: "col-source" }),
        h("col", { class: "col-date" }),
        h("col", { class: "col-action" }),
      ),
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          sortHeader("value", t("colValue")),
          sortHeader("list", t("colList")),
          sortHeader("scope", t("colScope")),
          sortHeader("source", t("colSource")),
          sortHeader("date", t("colDate")),
          h("th", { attrs: { scope: "col" } }, h("span", { class: "visually-hidden", text: t("colActions") })),
        ),
      ),
      rows,
    ),
    more,
  );

  function reset(): void {
    limit = PAGE;
    draw();
  }

  function scopeLabel(entry: Entry): string {
    return entry.scope === SCOPE_ALL || model === null ? t("scopeAll") : accountName(model, entry.scope);
  }

  function listLabel(entry: Entry): string {
    return t(entry.list === "white" ? "listWhite" : "listBlack");
  }

  /** What a column shows for an entry, as the text it is sorted by. */
  const sortText: Record<Exclude<SortKey, "date">, (entry: Entry) => string> = {
    value: (entry) => entry.value,
    list: listLabel,
    scope: scopeLabel,
    source: (entry) => tCode("source", entry.source),
  };
  /** Alphabetical in the language of the interface, ignoring case. */
  const collator = new Intl.Collator(stringsLocale(), { sensitivity: "accent", numeric: true });

  /** All entries that match, in the order of the chosen column. Entries that are equal there keep the newest first. */
  function sorted(entries: Entry[]): Entry[] {
    const direction = sort.descending ? -1 : 1;
    const key = sort.key;
    if (key === "date") {
      return entries.sort((a, b) => direction * (a.addedAt - b.addedAt) || collator.compare(a.value, b.value));
    }
    const text = sortText[key];
    const labels = new Map(entries.map((entry) => [entry, text(entry)]));
    return entries.sort(
      (a, b) => direction * collator.compare(labels.get(a) ?? "", labels.get(b) ?? "") || b.addedAt - a.addedAt || collator.compare(a.value, b.value),
    );
  }

  function remove(entry: Entry, row: HTMLElement): void {
    // The row is about to go: the keyboard goes on with the row next to it, or with the field for a new entry.
    focusNeighbor(row, addValue);
    // What the form said about its last entry is history once the list is changed again.
    addStatus.clear();
    void guard(async () => {
      await send("removeEntries", { keys: [keyOf(entry)] });
      // Undo puts the entry back exactly as it was, with its source and its date.
      removed.show(t("listsRemoved", entry.value), () => send("restoreEntries", { entries: [entry] }), t("listsRestored", entry.value));
    });
  }

  function row(entry: Entry): HTMLElement {
    const element = h(
      "tr",
      { tabIndex: -1 },
      h("td", { class: "value" }, address(entry.value)),
      h("td", { class: "nowrap", text: listLabel(entry) }),
      h("td", { class: "nowrap ellipsis", text: scopeLabel(entry), title: scopeLabel(entry) }),
      h("td", { class: "nowrap", text: tCode("source", entry.source) }),
      h("td", { class: "nowrap ellipsis", text: formatDate(entry.addedAt), title: formatFullTime(entry.addedAt) }),
      h("td", { class: "action" }),
    );
    element.lastElementChild?.appendChild(removeButton(t("removeNamed", entry.value), () => remove(entry, element)));
    return element;
  }

  function draw(): void {
    if (model === null) {
      return;
    }
    const needle = search.value.trim().toLowerCase();
    // The sort covers every entry that matches, not only the rows that are drawn.
    const matching = sorted(
      model.entries
        .filter((entry) => filter.value === "all" || entry.list === filter.value)
        .filter((entry) => source.value === "all" || entry.source === source.value)
        .filter((entry) => needle === "" || entry.value.includes(needle)),
    );
    for (const [key, cell] of headers) {
      if (key === sort.key) {
        cell.setAttribute("aria-sort", sort.descending ? "descending" : "ascending");
      } else {
        cell.removeAttribute("aria-sort");
      }
    }
    // Without a filter the line counts the rows, with one it counts what matches. The button under the table offers the rest.
    const total = model.entries.length;
    const filtered = filter.value !== "all" || source.value !== "all" || needle !== "";
    const count = total === 0 ? "" : filtered ? t("matchCount", matching.length, total) : t("logCount", Math.min(matching.length, limit), total);
    if (summary.textContent !== count) {
      summary.textContent = count;
    }
    summary.hidden = total === 0;
    reconcile(
      rows,
      matching.length === 0
        ? [
            {
              key: "empty",
              signature: String(model.entries.length === 0),
              build: () =>
                h("tr", { class: "empty-row" }, h("td", { colSpan: 6, class: "empty", text: t(model?.entries.length === 0 ? "listsEmpty" : "listsNoMatch") })),
            },
          ]
        : matching.slice(0, limit).map((entry) => ({
            key: keyOf(entry),
            signature: JSON.stringify([entry.list, entry.source, entry.addedAt, scopeLabel(entry)]),
            build: () => row(entry),
          })),
    );
    replace(
      more,
      matching.length > limit
        ? button(t("showMore", Math.min(PAGE, matching.length - limit), matching.length - limit), () => {
            const first = limit;
            limit += PAGE;
            draw();
            // The button was drawn anew, or is gone with the last rows: the keyboard stays on it, or goes on with the first new row.
            (more.querySelector("button") ?? rows.querySelectorAll<HTMLElement>("tr")[first])?.focus();
          })
        : null,
    );
  }

  return {
    render(next: Model) {
      model = next;
      if (next.settings === null) {
        return;
      }
      const white = next.entries.filter((entry) => entry.list === "white").length;
      const black = next.entries.length - white;
      counts.textContent = `${tn("listsWhiteCount", white)} ${tn("listsBlackCount", black)}`;
      newScope.value = next.settings.newEntryScope;
      sharingNote.hidden = next.accounts.length > 1;

      const scopeSignature = JSON.stringify(next.accounts.map((account) => [account.id, account.name]));
      if (addScope.dataset.signature !== scopeSignature) {
        const chosen = addScope.value;
        addScope.dataset.signature = scopeSignature;
        replace(
          addScope,
          option(SCOPE_ALL, t("scopeAll"), chosen === SCOPE_ALL),
          ...next.accounts.map((account) => option(account.id, t("scopeAccount", account.name), chosen === account.id)),
        );
      }
      draw();
    },
    leave() {
      removed.clear();
    },
  };
}
