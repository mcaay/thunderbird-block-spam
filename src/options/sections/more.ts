// Shortcuts, Log and Data (export and import).

import { EMPTY_LOG_META, KEY_LOG_META, logChunkKey } from "../../core/keys";
import type { LogMeta } from "../../core/keys";
import type { ImportMode, ImportReport } from "../../core/exportImport";
import type { LogEntry, Outcome } from "../../core/types";
import { t, tCode } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { button, byId, dialog, download, formatScore, formatTime, guard, h, option, replace, toast } from "../dom";
import type { Model } from "../model";
import type { Section } from "../section";

const COMMAND_LABELS: Record<string, string> = {
  "block-address": "cmdBlockAddress",
  "block-domain": "cmdBlockDomain",
  "trust-address": "cmdTrustAddress",
  "trust-domain": "cmdTrustDomain",
};

export function shortcutsSection(): Section {
  const root = byId("shortcuts");
  const bindings = h("tbody");
  const smart = h("input", {
    type: "checkbox",
    id: "smart-switch",
    onchange: () => void guard(() => send("updateSettings", { patch: { smart: smart.checked } })),
  });

  async function drawBindings(): Promise<void> {
    const commands = await browser.commands.getAll();
    replace(
      bindings,
      ...commands
        .filter((command) => command.name !== undefined && COMMAND_LABELS[command.name] !== undefined)
        .map((command) =>
          h(
            "tr",
            {},
            h("td", { text: t(COMMAND_LABELS[command.name ?? ""] ?? "") }),
            h("td", {}, h("kbd", { text: command.shortcut === undefined || command.shortcut === "" ? t("shortcutNone") : command.shortcut })),
          ),
        ),
    );
  }

  replace(
    root,
    h("h2", { text: t("sectionShortcuts") }),
    h("p", { class: "hint", text: t("shortcutsHint") }),
    h("table", { class: "narrow" }, bindings),
    h("div", { class: "row" }, button(t("shortcutsChange"), () => void guard(() => browser.commands.openShortcutSettings()))),
    h("p", { class: "hint", text: t("shortcutsRebindHint") }),
    h("div", { class: "switch-row" }, smart, h("label", { for: "smart-switch", text: t("smartLabel") })),
    h("p", { class: "hint", text: t("smartHint") }),
    h("h3", { text: t("bareKeysTitle") }),
    h("p", { class: "hint", text: t("bareKeysHint") }),
  );
  browser.commands.onChanged.addListener(() => void guard(drawBindings));

  return {
    render(model: Model) {
      if (model.settings !== null) {
        smart.checked = model.settings.smart;
      }
      void guard(drawBindings);
    },
  };
}

const OUTCOMES: Outcome[] = ["trusted", "blocked", "spam", "passed", "no-verdict", "released", "error"];
const LOG_PAGE = 100;

export function logSection(): Section {
  const root = byId("log");
  let entries: LogEntry[] = [];
  let limit = LOG_PAGE;
  let loadedMeta = "";

  const filter = h(
    "select",
    {
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
  const rows = h("tbody");
  const more = h("div", { class: "actions" });
  const summary = h("p", { class: "hint" });

  replace(
    root,
    h("h2", { text: t("sectionLog") }),
    h("p", { class: "hint", text: t("logHint") }),
    h(
      "div",
      { class: "row" },
      filter,
      button(t("refresh"), () => void guard(() => load(true))),
      button(
        t("logClear"),
        () =>
          void dialog({
            title: t("logClearTitle"),
            body: [t("logClearText")],
            confirmLabel: t("logClear"),
            danger: true,
            onConfirm: async () => {
              await send("clearLog", {});
            },
          }),
        "danger",
      ),
    ),
    summary,
    h(
      "table",
      { class: "log" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", { text: t("colTime") }),
          h("th", { text: t("colAccount") }),
          h("th", { text: t("colSender") }),
          h("th", { text: t("colSubject") }),
          h("th", { text: t("colOutcome") }),
          h("th", { text: t("colScore") }),
          h("th", { text: t("colReason") }),
        ),
      ),
      rows,
    ),
    more,
  );

  function senderText(entry: LogEntry): string {
    const sender = entry.sender === "" ? t("logUnknownSender") : entry.sender;
    return entry.via === "" ? sender : t("logVia", sender, entry.via);
  }

  function outcomeCell(entry: LogEntry): HTMLElement {
    const badges = [h("span", { class: `badge outcome-${entry.outcome}`, text: tCode("outcome", entry.outcome) })];
    if (entry.action !== "none") {
      badges.push(h("span", { class: "badge action", text: tCode("action", entry.action) }));
    }
    if (entry.observed) {
      badges.push(h("span", { class: "badge paused", text: t("logObservedBadge") }));
    }
    if (entry.test) {
      badges.push(h("span", { class: "badge plan", text: t("logTestBadge") }));
    }
    return h("td", {}, ...badges);
  }

  function draw(): void {
    const matching = entries.filter((entry) =>
      filter.value === "all"
        ? true
        : filter.value === "tests"
          ? entry.test
          : filter.value === "observed"
            ? entry.observed
            : entry.outcome === filter.value,
    );
    summary.textContent = t("logCount", matching.length, entries.length);
    replace(
      rows,
      ...matching.slice(0, limit).map((entry) => {
        const reason = tCode("reason", entry.reason);
        return h(
          "tr",
          {},
          h("td", { text: formatTime(entry.time), class: "nowrap" }),
          h("td", { text: entry.account }),
          h("td", { text: senderText(entry), class: "value" }),
          h("td", { text: entry.subject }),
          outcomeCell(entry),
          h("td", { text: formatScore(entry.score), title: entry.accessPoint }),
          h("td", {}, h("div", { text: reason }), entry.detail === "" ? null : h("small", { text: entry.detail }), entry.accessPoint === "" ? null : h("small", { text: entry.accessPoint })),
        );
      }),
    );
    if (matching.length === 0) {
      replace(rows, h("tr", {}, h("td", { colSpan: 7, class: "empty", text: t("logEmpty") })));
    }
    replace(
      more,
      matching.length > limit
        ? button(t("showMore", matching.length - limit), () => {
            limit += LOG_PAGE;
            draw();
          })
        : null,
    );
  }

  /** Full chunks never change again, so they are read once. */
  const fullChunks = new Map<number, LogEntry[]>();

  /** Reads the log chunks. The page only reads storage. */
  async function load(force: boolean): Promise<void> {
    const stored = await browser.storage.local.get(KEY_LOG_META);
    const meta = (stored[KEY_LOG_META] as LogMeta | undefined) ?? EMPTY_LOG_META;
    const lastKey = logChunkKey(meta.last);
    const last = ((await browser.storage.local.get(lastKey))[lastKey] as LogEntry[] | undefined) ?? [];
    const signature = `${meta.first}:${meta.last}:${last.length}`;
    if (!force && signature === loadedMeta) {
      return;
    }
    loadedMeta = signature;
    for (const index of [...fullChunks.keys()]) {
      if (index < meta.first || index >= meta.last) {
        fullChunks.delete(index);
      }
    }
    const missing: string[] = [];
    for (let index = meta.first; index < meta.last; index += 1) {
      if (!fullChunks.has(index)) {
        missing.push(logChunkKey(index));
      }
    }
    const chunks = missing.length === 0 ? {} : await browser.storage.local.get(missing);
    const loaded: LogEntry[] = [];
    for (let index = meta.first; index < meta.last; index += 1) {
      const chunk = fullChunks.get(index) ?? (chunks[logChunkKey(index)] as LogEntry[] | undefined) ?? [];
      fullChunks.set(index, chunk);
      loaded.push(...chunk);
    }
    loaded.push(...last);
    entries = loaded.reverse();
    draw();
  }

  return {
    render(model: Model) {
      // Stored data that failed validation is not read any further.
      if (model.status.fatal === null) {
        void guard(() => load(false));
      }
    },
  };
}

function reportLines(report: ImportReport): string[] {
  const lines = [t("importEntries", report.entriesAdded, report.entriesReplaced, report.entriesUnchanged)];
  if (report.mode === "replace") {
    lines.push(t("importReplaced", report.accessPoints));
  }
  for (const item of report.skipped) {
    lines.push(item.account === "" ? t("importSkippedFolder", item.item) : t("importSkippedAccount", item.item, item.account));
  }
  return lines;
}

export function dataSection(): Section {
  const root = byId("data");
  const file = h("input", { type: "file" });
  file.accept = "application/json,.json";
  const mode = h("select", {}, option("merge", t("importMerge")), option("replace", t("importReplace")));
  const report = h("div");

  const runImport = async (): Promise<void> => {
    const chosen = file.files?.[0];
    if (chosen === undefined) {
      toast(t("importChooseFile"), "error");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await chosen.text()) as unknown;
    } catch {
      toast(t("importNotJson"), "error");
      return;
    }
    const selected = mode.value as ImportMode;
    const apply = async (): Promise<void> => {
      const result = await send("importData", { file: parsed, mode: selected });
      replace(report, h("h4", { text: t("importDone") }), h("ul", {}, ...reportLines(result).map((line) => h("li", { text: line }))));
      file.value = "";
    };
    if (selected === "replace") {
      await dialog({
        title: t("importReplaceTitle"),
        body: [t("importReplaceText")],
        confirmLabel: t("importReplaceConfirm"),
        danger: true,
        onConfirm: apply,
      });
    } else {
      await apply();
    }
  };

  replace(
    root,
    h("h2", { text: t("sectionData") }),
    h("h3", { text: t("exportTitle") }),
    h("p", { class: "hint", text: t("exportHint") }),
    h(
      "div",
      { class: "row" },
      button(
        t("exportButton"),
        () =>
          void guard(async () => {
            const result = await send("exportData", {});
            download(`block-spam-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(result.file, null, 2));
            if (result.skipped > 0) {
              toast(t("exportSkipped", result.skipped));
            }
          }),
        "primary",
      ),
    ),
    h("h3", { text: t("importTitle") }),
    h("p", { class: "hint", text: t("importHint") }),
    h("div", { class: "row" }, file, mode, button(t("importButton"), () => void guard(runImport))),
    report,
    h("h3", { text: t("privacyTitle") }),
    h("p", { class: "hint", text: t("privacyText") }),
  );

  return {
    render() {
      // Nothing here depends on stored data.
    },
  };
}
