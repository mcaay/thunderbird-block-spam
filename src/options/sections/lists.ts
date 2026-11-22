// Lists: the white list and the black list with add and remove, and the table of all
// entries: filters by list and by source, a search, and a sort by every column.

import { keyOf } from "../../core/lists";
import { SCOPE_ALL } from "../../core/types";
import type { Entry, EntrySource } from "../../core/types";
import { stringsLocale, t, tCode, tn } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import {
  address,
  button,
  byId,
  errorText,
  fieldError,
  h,
  learnMore,
  notice,
  oneTabStop,
  option,
  paneLink,
  reconcile,
  removeButton,
  removedRows,
  replace,
  tNodes,
  withMore,
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
  /** The entries that were removed and still stand in their place as quiet rows with Undo, until the next other action in the table. */
  const removed = removedRows(() => draw());

  const counts = h("p", { class: "counts" });
  const filter = h(
    "select",
    // The label next to it says "Show:". The name says what is shown.
    { id: "entries-filter", onchange: () => reset(), attrs: { "aria-label": t("listsFilterName") } },
    option("all", t("listsBoth")),
    option("white", t("listWhite")),
    option("black", t("listBlack")),
  );
  const source = h(
    "select",
    { id: "entries-source", onchange: () => reset(), attrs: { "aria-label": t("listsSourceName") } },
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
  /** The table body is one tab stop: the arrow keys move between its rows, and Tab leaves it for what follows. */
  const tabStop = oneTabStop(rows);
  const more = h("div", { class: "row" });
  /** How many entries are shown, or how many match the filter and the search, out of how many. */
  const summary = h("p", { class: "description count-line", attrs: { role: "status" } });

  const addValue = h("input", {
    type: "text",
    id: "entry-value",
    placeholder: t("listsValuePlaceholder"),
    oninput: () => {
      valueError.set(null);
      untouched = false;
      // Nothing can be added before something is typed: the button says so by being unavailable.
      addButton.disabled = addValue.value.trim() === "";
    },
    onkeydown: (event) => {
      // After an add the keyboard is back in this field, where the shortcut of Undo belongs to the typed text. Until
      // something is typed there is no text to take back, so the shortcut takes back the add, as the button says.
      const undo = addStatus.element.querySelector<HTMLElement>('button[data-focus="undo"]');
      if (untouched && undo !== null && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo.click();
      }
    },
    attrs: { autocomplete: "off", spellcheck: "false" },
  });
  /** True from an add until something is typed into the field again. */
  let untouched = false;
  const valueError = fieldError(addValue, "entry-value-error");
  const addList = h("select", { id: "entry-list" }, option("white", t("listWhite")), option("black", t("listBlack")));
  const addScope = h("select", { id: "entry-scope" });
  /** What the last add did, with Undo. It stands under the form. Closed, the keyboard goes back to the field for the next entry. */
  const addStatus = notice(() => addValue);
  const addButton = h("button", { type: "submit", text: t("add"), disabled: true, attrs: { "aria-label": t("listsAddName") } });
  /** The "Applies to" menu of the form. With fewer than two accounts it could change nothing, and is not shown. */
  const scopeField = h("div", { class: "field" }, h("label", { for: "entry-scope", text: t("listsScopeLabel") }), addScope);
  /**
   * Whether the table shows to which account an entry applies: with two or more accounts, and with fewer as long
   * as an entry is limited to an account that is not the one that is left (an account that was removed), so that
   * nothing that decides is hidden.
   */
  let showScope = true;
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
            const reply = await send("addEntry", { list: addList.value, value: addValue.value, scope: scopeField.hidden ? SCOPE_ALL : addScope.value });
            valueError.set(null);
            addValue.value = "";
            untouched = true;
            addButton.disabled = true;
            const white = reply.list === "white";
            const said =
              reply.result === "added"
                ? t(white ? "listsAddedWhite" : "listsAddedBlack", reply.value)
                : reply.result === "moved"
                  ? t(white ? "listsMovedWhite" : "listsMovedBlack", reply.value)
                  : reply.result === "source-updated"
                    ? // The entry was there, made by learning or by an AI score: it is now one made by hand, and the line says so.
                      t("listsNowManual", reply.value)
                    : t("listsAlreadyThere", reply.value);
            // What is true again once the add is taken back: the entry is on neither list, on the list it was moved from, or has the source it had.
            const [was] = reply.undo.restore;
            const back =
              reply.result === "added"
                ? tCode("logUndone", "neither-again", reply.value)
                : was === undefined
                  ? undefined
                  : reply.result === "moved"
                    ? tCode("logUndone", was.list === "black" ? "black-again" : "white-again", reply.value)
                    : t("listsSourceBack", reply.value, tCode("source", was.source));
            // Undo takes the add back exactly: a new entry is removed, a moved or changed one is put back with its list, source and date.
            addStatus.show(
              said,
              back === undefined
                ? undefined
                : async () => {
                    if (reply.undo.remove.length > 0) {
                      await send("removeEntries", { keys: reply.undo.remove });
                    }
                    if (reply.undo.restore.length > 0) {
                      await send("restoreEntries", { entries: reply.undo.restore });
                    }
                  },
              back,
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
    scopeField,
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
        removed.clear();
        limit = PAGE;
        draw();
      },
      "sort",
    );
    // The header names its column. The tooltip says what a press does, without saying the name again.
    press.title = t("sortBy");
    const cell = h("th", { attrs: { scope: "col" } }, press);
    headers.set(key, cell);
    return cell;
  }

  const scopeColumn = h("col", { class: "col-scope" });

  /**
   * Whether the entries the add-on makes by itself are shared by all accounts is set once, in Advanced. With two or
   * more mail accounts "Learn more" says so and leads there. With one it could change nothing, and is not said.
   */
  const sharingNote = h("p", { hidden: true }, ...tNodes("listsMoreSharing", paneLink("advanced", t("catAdvanced"), () => {
      location.hash = "advanced";
    })));

  replace(
    root,
    h("h1", { text: t("catLists"), tabIndex: -1 }),
    h("p", { class: "lead" }, ...withMore(t("listsHint"), learnMore(t("catLists"), t("listsMore"), sharingNote))),
    counts,
    h("h2", { text: t("listsAddTitle") }),
    addForm,
    valueError.element,
    addStatus.element,
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
    h(
      "table",
      { class: "entries" },
      h(
        "colgroup",
        {},
        h("col", {}),
        h("col", { class: "col-list" }),
        scopeColumn,
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
    // Another view of the table: the rows that were removed leave their places.
    removed.clear();
    limit = PAGE;
    draw();
  }

  // The form lays its fields out in one line, and the address field takes what the others leave.
  addScope.addEventListener("change", () => drawScopeTitle());

  /** The whole name of the chosen account, for when the menu is too narrow for it. */
  function drawScopeTitle(): void {
    addScope.title = addScope.value === SCOPE_ALL ? "" : (addScope.selectedOptions[0]?.textContent ?? "");
  }

  function scopeLabel(entry: Entry): string {
    if (entry.scope === SCOPE_ALL || model === null) {
      return t("scopeAll");
    }
    // An entry can outlive its account: it is said to belong to an account that was removed, not shown by an internal name.
    return model.accounts.some((account) => account.id === entry.scope) ? accountName(model, entry.scope) : t("scopeGone");
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
    // What the form said about its last entry is history once the list is changed again.
    addStatus.clear();
    // The row stays in its place as a quiet row, so nothing moves under the pointer. Undo puts the entry back exactly as it was, with its source and its date.
    removed.remove(
      row,
      t("listsRemoved", entry.value),
      () => send("removeEntries", { keys: [keyOf(entry)] }),
      () => send("restoreEntries", { entries: [entry] }),
      t("listsRestored", entry.value),
    );
  }

  /** An entry that was removed: one quiet line over all columns, as high as the row it stands for. */
  function removedRow(key: string): HTMLElement {
    return h("tr", { class: "removed-row", tabIndex: -1 }, h("td", { colSpan: showScope ? 6 : 5, class: "removed" }, h("div", { class: "removed-line" }, ...removed.content(key))));
  }

  function row(entry: Entry): HTMLElement {
    const element = h(
      "tr",
      { tabIndex: -1 },
      h("td", { class: "value" }, address(entry.value)),
      h("td", { class: "nowrap", text: listLabel(entry) }),
      showScope ? h("td", { class: "nowrap ellipsis", text: scopeLabel(entry), title: scopeLabel(entry) }) : null,
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
    const shown = new Map(matching.slice(0, limit).map((entry) => [keyOf(entry), entry]));
    const keys = removed.order([...shown.keys()]);
    reconcile(
      rows,
      keys.length === 0
        ? [
            {
              key: "empty",
              signature: `${model.entries.length === 0}|${showScope}`,
              build: () =>
                h("tr", { class: "empty-row" }, h("td", { colSpan: showScope ? 6 : 5, class: "empty", text: t(model?.entries.length === 0 ? "listsEmpty" : "listsNoMatch") })),
            },
          ]
        : keys.map((key) => {
            const entry = shown.get(key);
            return entry === undefined || removed.has(key)
              ? { key, signature: `removed|${removed.signature(key)}|${showScope}`, build: () => removedRow(key) }
              : { key, signature: JSON.stringify([entry.list, entry.source, entry.addedAt, scopeLabel(entry), showScope]), build: () => row(entry) };
          }),
    );
    // Rows that were drawn anew or added join the one tab stop.
    tabStop.sync();
    replace(
      more,
      matching.length > limit
        ? button(t("showMore", Math.min(PAGE, matching.length - limit), matching.length - limit), () => {
            const first = limit;
            removed.clear();
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
      // Two short sentences: where the line has to break, it breaks between them.
      replace(counts, h("span", { class: "sentence", text: tn("listsWhiteCount", white) }), " ", h("span", { class: "sentence", text: tn("listsBlackCount", black) }));
      // With fewer than two mail accounts nothing here could make a difference: the menu of the form, the column and
      // the sentence about sharing are not shown. Entries then apply as they would have: to all accounts, or to the one account.
      const several = next.accounts.length > 1;
      const only = next.accounts[0]?.id;
      sharingNote.hidden = !several;
      scopeField.hidden = !several;
      showScope = several || next.entries.some((entry) => entry.scope !== SCOPE_ALL && entry.scope !== only);
      scopeColumn.hidden = !showScope;
      const scopeHeader = headers.get("scope");
      if (scopeHeader !== undefined) {
        scopeHeader.hidden = !showScope;
      }
      if (!showScope && sort.key === "scope") {
        sort = { key: "date", descending: true };
      }

      const scopeSignature = JSON.stringify(next.accounts.map((account) => [account.id, account.name]));
      if (addScope.dataset.signature !== scopeSignature) {
        const chosen = addScope.value;
        addScope.dataset.signature = scopeSignature;
        replace(
          addScope,
          option(SCOPE_ALL, t("scopeAll"), chosen === SCOPE_ALL),
          ...next.accounts.map((account) => option(account.id, t("scopeAccount", account.name), chosen === account.id)),
        );
        drawScopeTitle();
      }
      draw();
    },
    unsaved() {
      // An address that was typed and not added yet is lost with the page.
      return addValue.value.trim() !== "";
    },
    leave() {
      addStatus.clear();
      removed.clear();
    },
  };
}
