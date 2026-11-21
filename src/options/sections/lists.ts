// Lists: the white list and the black list with search, add and remove, and the
// scope of entries the add-on creates by itself.

import { keyOf } from "../../core/lists";
import { SCOPE_ALL } from "../../core/types";
import type { Entry, Settings } from "../../core/types";
import { t, tCode, tn } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { address, button, byId, description, errorText, fieldError, guard, h, iconButton, inlineStatus, learnMore, option, reconcile, replace, toast } from "../dom";
import { formatDate, formatFullTime } from "../format";
import { accountName } from "../model";
import type { Model } from "../model";
import type { Section } from "../section";

const PAGE = 200;

export function listsSection(): Section {
  const root = byId("lists");
  let model: Model | null = null;
  let limit = PAGE;
  /** A removal that is not drawn yet, and the row whose remove button gets the focus once it is. */
  let pendingRemoval: { key: string; neighbor: string | null } | null = null;

  const counts = h("p", { class: "counts" });
  const filter = h(
    "select",
    { id: "entries-filter", onchange: () => reset() },
    option("all", t("listsBoth")),
    option("white", t("listWhite")),
    option("black", t("listBlack")),
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

  const addValue = h("input", {
    type: "text",
    id: "entry-value",
    placeholder: t("listsValuePlaceholder"),
    oninput: () => {
      valueError.set(null);
      addStatus.clear();
    },
    attrs: { autocomplete: "off", spellcheck: "false" },
  });
  const valueError = fieldError(addValue, "entry-value-error");
  const addList = h("select", { id: "entry-list" }, option("white", t("listWhite")), option("black", t("listBlack")));
  const addScope = h("select", { id: "entry-scope" });
  const addStatus = inlineStatus();
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
        void (async () => {
          try {
            const reply = await send("addEntry", { list: addList.value, value: addValue.value, scope: addScope.value });
            valueError.set(null);
            addValue.value = "";
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
    h("button", { type: "submit", text: t("add") }),
  );

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
    description(t("listsHint"), learnMore(t("catLists"), t("listsMore"))),
    counts,
    h("h2", { text: t("listsAddTitle") }),
    addForm,
    valueError.element,
    addStatus.element,
    h("h2", { text: t("listsEntriesTitle") }),
    h("div", { class: "row filters" }, h("label", { for: "entries-filter", text: t("listsFilterLabel") }), filter, search),
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
          h("th", { text: t("colValue"), attrs: { scope: "col" } }),
          h("th", { text: t("colList"), attrs: { scope: "col" } }),
          h("th", { text: t("colScope"), attrs: { scope: "col" } }),
          h("th", { text: t("colSource"), attrs: { scope: "col" } }),
          h("th", { text: t("colDate"), attrs: { scope: "col" } }),
          h("th", { attrs: { scope: "col" } }, h("span", { class: "visually-hidden", text: t("colActions") })),
        ),
      ),
      rows,
    ),
    more,
    h("h2", { text: t("newEntriesTitle") }),
    h("div", { class: "row" }, h("label", { for: "new-scope", text: t("newEntriesLabel") }), newScope),
    description(t("newEntriesHint")),
  );

  function reset(): void {
    limit = PAGE;
    draw();
  }

  function scopeLabel(entry: Entry): string {
    return entry.scope === SCOPE_ALL || model === null ? t("scopeAll") : accountName(model, entry.scope);
  }

  function remove(entry: Entry, row: HTMLElement): void {
    const neighbor = row.nextElementSibling ?? row.previousElementSibling;
    pendingRemoval = { key: keyOf(entry), neighbor: neighbor instanceof HTMLElement ? (neighbor.dataset.key ?? null) : null };
    // What the form said about its last entry is history once the list is changed again.
    addStatus.clear();
    void guard(async () => {
      await send("removeEntries", { keys: [keyOf(entry)] });
      toast(t("listsRemoved", entry.value), {
        // Undo puts the entry back exactly as it was, with its source and its date.
        undo: () => send("restoreEntries", { entries: [entry] }),
      });
    });
  }

  function row(entry: Entry): HTMLElement {
    const element = h(
      "tr",
      {},
      h("td", { class: "value" }, address(entry.value)),
      h("td", { class: "nowrap", text: t(entry.list === "white" ? "listWhite" : "listBlack") }),
      h("td", { class: "nowrap ellipsis", text: scopeLabel(entry), title: scopeLabel(entry) }),
      h("td", { class: "nowrap", text: tCode("source", entry.source) }),
      h("td", { class: "nowrap", text: formatDate(entry.addedAt), title: formatFullTime(entry.addedAt) }),
      h("td", { class: "action" }),
    );
    const removeButton = iconButton("close", t("removeNamed", entry.value), () => remove(entry, element), "quiet");
    removeButton.dataset.focus = "remove";
    element.lastElementChild?.appendChild(removeButton);
    return element;
  }

  function draw(): void {
    if (model === null) {
      return;
    }
    const needle = search.value.trim().toLowerCase();
    const matching = model.entries
      .filter((entry) => filter.value === "all" || entry.list === filter.value)
      .filter((entry) => needle === "" || entry.value.includes(needle))
      .sort((a, b) => b.addedAt - a.addedAt || a.value.localeCompare(b.value));
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
    const removal = pendingRemoval;
    if (removal !== null && !model.entries.some((entry) => keyOf(entry) === removal.key)) {
      // The row that had the focus is gone: the keyboard goes on with its neighbor.
      pendingRemoval = null;
      if (document.activeElement === document.body || document.activeElement === null) {
        const target = [...rows.querySelectorAll<HTMLElement>("tr")].find((candidate) => candidate.dataset.key === removal.neighbor);
        (target?.querySelector<HTMLElement>("button") ?? addValue).focus();
      }
    }
    replace(
      more,
      matching.length > limit
        ? button(t("showMore", matching.length - limit), () => {
            limit += PAGE;
            draw();
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
  };
}
