// Lists: the white list and the black list with search, add and remove.

import { keyOf } from "../../core/lists";
import { SCOPE_ALL } from "../../core/types";
import type { Entry } from "../../core/types";
import { t, tCode } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { button, byId, formatDate, guard, h, option, replace, toast } from "../dom";
import { accountName } from "../model";
import type { Model } from "../model";
import type { Section } from "../section";

const PAGE = 200;

export function listsSection(): Section {
  const root = byId("lists");
  let model: Model | null = null;
  let limit = PAGE;

  const counts = h("p", { class: "hint" });
  const filter = h("select", { onchange: () => reset() }, option("all", t("listsBoth")), option("white", t("listWhite")), option("black", t("listBlack")));
  const search = h("input", { type: "search", placeholder: t("listsSearch"), oninput: () => reset() });
  const table = h("tbody");
  const more = h("div", { class: "actions" });

  const addList = h("select", {}, option("white", t("listWhite")), option("black", t("listBlack")));
  const addKind = h("select", {}, option("address", t("kindAddress")), option("domain", t("kindDomain")));
  const addValue = h("input", { type: "text", placeholder: t("listsValuePlaceholder") });
  const addScope = h("select");
  const addForm = h(
    "form",
    {
      class: "row",
      onsubmit: (event) => {
        event.preventDefault();
        void guard(async () => {
          const reply = await send("addEntry", {
            list: addList.value,
            kind: addKind.value,
            value: addValue.value,
            scope: addScope.value,
          });
          toast(reply.result === "unchanged" ? t("listsAlreadyThere", reply.value) : t("listsAdded", reply.value));
          addValue.value = "";
        });
      },
    },
    addList,
    addKind,
    addValue,
    addScope,
    h("button", { type: "submit", text: t("add"), class: "primary" }),
  );

  replace(
    root,
    h("h2", { text: t("sectionLists") }),
    h("p", { class: "hint", text: t("listsHint") }),
    counts,
    h("h3", { text: t("listsAddTitle") }),
    addForm,
    h("div", { class: "row" }, filter, search),
    h(
      "table",
      {},
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", { text: t("colValue") }),
          h("th", { text: t("colList") }),
          h("th", { text: t("colKind") }),
          h("th", { text: t("colScope") }),
          h("th", { text: t("colSource") }),
          h("th", { text: t("colDate") }),
          h("th", {}),
        ),
      ),
      table,
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

  function draw(): void {
    if (model === null) {
      return;
    }
    const needle = search.value.trim().toLowerCase();
    const matching = model.entries
      .filter((entry) => filter.value === "all" || entry.list === filter.value)
      .filter((entry) => needle === "" || entry.value.includes(needle))
      .sort((a, b) => b.addedAt - a.addedAt || a.value.localeCompare(b.value));
    replace(
      table,
      ...matching.slice(0, limit).map((entry) =>
        h(
          "tr",
          {},
          h("td", { text: entry.value, class: "value" }),
          h("td", {}, h("span", { class: `badge ${entry.list}`, text: t(entry.list === "white" ? "listWhite" : "listBlack") })),
          h("td", { text: t(entry.kind === "address" ? "kindAddress" : "kindDomain") }),
          h("td", { text: scopeLabel(entry) }),
          h("td", { text: tCode("source", entry.source) }),
          h("td", { text: formatDate(entry.addedAt) }),
          h("td", {}, button(t("remove"), () => void guard(() => send("removeEntries", { keys: [keyOf(entry)] })), "small")),
        ),
      ),
    );
    if (matching.length === 0) {
      replace(table, h("tr", {}, h("td", { colSpan: 7, class: "empty", text: t("listsEmpty") })));
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
      const white = next.entries.filter((entry) => entry.list === "white").length;
      counts.textContent = t("listsCounts", white, next.entries.length - white);
      const chosen = addScope.value;
      replace(
        addScope,
        option(SCOPE_ALL, t("scopeAll"), chosen === SCOPE_ALL),
        ...next.accounts.map((account) => option(account.id, t("scopeAccount", account.name), chosen === account.id)),
      );
      draw();
    },
  };
}
