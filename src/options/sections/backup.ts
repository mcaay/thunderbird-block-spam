// Export and import: one file with the lists, the settings and the AI services
// without their secrets.

import type { ImportMode } from "../../core/exportImport";
import { t } from "../../tb/i18n";
import { RequestError, send } from "../../tb/protocol";
import type { ImportReply } from "../../tb/protocol";
import { addressed, bar, button, byId, description, dialog, download, errorText, guard, h, inlineStatus, learnMore, named, option, replace, whileBusy } from "../dom";
import type { Section } from "../section";

function reportLines(report: ImportReply): string[] {
  const lines = [t("importEntries", report.entriesAdded, report.entriesReplaced, report.entriesUnchanged)];
  if (report.mode === "replace") {
    lines.push(t("importReplaced", report.accessPoints));
  }
  if (report.servicesOff > 0) {
    lines.push(t("importServicesOff", report.servicesOff));
  }
  for (const item of report.skipped) {
    lines.push(item.account === "" ? t("importSkippedFolder", item.item) : t("importSkippedAccount", item.item, item.account));
  }
  return lines;
}

export function backupSection(): Section {
  const root = byId("backup");
  // The file input itself stays hidden: its button and its text would come from the
  // platform, in the language of Thunderbird rather than of these strings.
  const file = h("input", { type: "file", hidden: true, tabIndex: -1, attrs: { accept: "application/json,.json", "aria-hidden": "true" } });
  const fileName = h("span", { class: "file-name", id: "import-file-name", text: t("importNoFile") });
  const choose = button(t("importChoose"), () => file.click());
  choose.setAttribute("aria-describedby", "import-file-name");
  // The label next to it says "Mode:". The name says of what.
  const mode = h("select", { id: "import-mode", attrs: { "aria-label": t("importModeName") } }, option("merge", t("importMerge")), option("replace", t("importReplace")));
  const problem = h("div", { class: "field-error", hidden: true, attrs: { role: "alert" } });
  // It can take the focus, for when the Undo button that was pressed is gone: then it reads what was restored.
  const report = h("div", { class: "import-report notice", tabIndex: -1, attrs: { role: "group" } });
  /** Set while the last merge can still be taken back. */
  let undoable = false;
  const exportStatus = inlineStatus();

  // Nothing to import before a file is chosen: the button is unavailable until then.
  const importButton = button(t("importButton"), () => void whileBusy(importButton, runImport).then(drawImport));
  function drawImport(): void {
    const empty = file.files?.[0] === undefined;
    if (empty && document.activeElement === importButton) {
      // The file is used up and the button about to be unavailable again: the keyboard goes back to where the next
      // file is chosen. The focus moves first, so that the focus ring moves with it.
      choose.focus();
    }
    importButton.disabled = empty;
  }
  drawImport();

  file.addEventListener("change", () => {
    const chosen = file.files?.[0]?.name;
    fileName.textContent = chosen ?? t("importNoFile");
    // The whole name, for when it is too long for its line.
    fileName.title = chosen ?? "";
    showProblem(null);
    drawImport();
  });

  function showProblem(message: string | null): void {
    problem.textContent = message ?? "";
    problem.hidden = message === null;
  }

  async function runImport(): Promise<void> {
    const chosen = file.files?.[0];
    replace(report);
    if (chosen === undefined) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await chosen.text()) as unknown;
    } catch {
      showProblem(t("importNotJson"));
      return;
    }
    const selected = mode.value as ImportMode;
    const apply = async (): Promise<void> => {
      const result = await send("importData", { file: parsed, mode: selected });
      showProblem(null);
      const undoId = result.undoId;
      undoable = undoId !== null;
      // A merge that added or moved entries can be taken back, exactly.
      const undo: HTMLButtonElement | null =
        undoId === null
          ? null
          : button(t("undo"), () =>
              void whileBusy(undo as HTMLButtonElement, () =>
                guard(
                  async () => {
                    const undone = await send("undoImport", { id: undoId });
                    undoable = false;
                    const text = t("importUndone", undone.removed, undone.restored);
                    const box = bar("information", [text]);
                    box.setAttribute("role", "status");
                    report.setAttribute("aria-label", text);
                    replace(report, box);
                    // The button that was pressed is gone: the confirmation takes the focus, so that the keyboard stays here.
                    report.focus({ preventScroll: true });
                  },
                  (message) => showProblem(message),
                ),
              ),
            );
      if (undo !== null) {
        // The name says what is taken back.
        named(undo, t("importTitle"));
      }
      report.removeAttribute("aria-label");
      replace(
        report,
        bar("success", [h("strong", { text: t("importDone") }), h("ul", {}, ...reportLines(result).map((line) => h("li", {}, ...addressed(line))))], [undo]),
      );
      report.firstElementChild?.setAttribute("role", "status");
      file.value = "";
      fileName.textContent = t("importNoFile");
      fileName.removeAttribute("title");
    };
    try {
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
    } catch (error) {
      // What is wrong with the file is a diagnostic in English: it follows the sentence in the user's language.
      showProblem(error instanceof RequestError && error.code !== "" ? `${errorText(error)} ${t("errorDetail", error.message)}` : errorText(error));
    }
  }

  replace(
    root,
    h("h1", { text: t("catBackup"), tabIndex: -1 }),
    h("p", { class: "lead", text: t("backupLead") }),
    h("h2", { text: t("exportTitle") }),
    description(t("exportHint")),
    h(
      "div",
      { class: "row" },
      button(t("exportButton"), () =>
        void guard(
          async () => {
            const result = await send("exportData", {});
            download(`block-spam-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(result.file, null, 2));
            exportStatus.set(result.skipped > 0 ? t("exportSkipped", result.skipped) : t("exportDone"), "ok");
          },
          (message) => exportStatus.set(message, "error"),
        ),
      ),
      exportStatus.element,
    ),
    h("h2", { text: t("importTitle") }),
    description(t("importHint"), learnMore(t("importTitle"), t("importMore"))),
    h("div", { class: "row" }, choose, fileName, file),
    h("div", { class: "row" }, h("label", { for: "import-mode", text: t("importModeLabel") }), mode, importButton),
    problem,
    report,
  );

  return {
    render() {
      // Nothing here depends on stored data.
    },
    leave() {
      // What the last import did was said here and is history once the pane is left, like every confirmation in place.
      report.removeAttribute("aria-label");
      replace(report);
      exportStatus.clear();
      if (undoable) {
        undoable = false;
        void send("forgetImport", {}).catch(() => undefined);
      }
    },
  };
}
