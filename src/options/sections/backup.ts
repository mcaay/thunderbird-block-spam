// Export and import: one file with the lists, the settings and the AI services
// without their secrets.

import type { ImportMode, ImportReport } from "../../core/exportImport";
import { t } from "../../tb/i18n";
import { RequestError, send } from "../../tb/protocol";
import { bar, button, byId, description, dialog, download, errorText, guard, h, inlineStatus, learnMore, option, replace } from "../dom";
import type { Section } from "../section";

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

export function backupSection(): Section {
  const root = byId("backup");
  // The file input itself stays hidden: its button and its text would come from the
  // platform, in the language of Thunderbird rather than of these strings.
  const file = h("input", { type: "file", hidden: true, tabIndex: -1, attrs: { accept: "application/json,.json", "aria-hidden": "true" } });
  const fileName = h("span", { class: "file-name", id: "import-file-name", text: t("importNoFile") });
  const choose = button(t("importChoose"), () => file.click());
  choose.setAttribute("aria-describedby", "import-file-name");
  const mode = h("select", { id: "import-mode" }, option("merge", t("importMerge")), option("replace", t("importReplace")));
  const problem = h("div", { class: "field-error", hidden: true, attrs: { role: "alert" } });
  const report = h("div", { class: "import-report" });
  const exportStatus = inlineStatus();

  file.addEventListener("change", () => {
    fileName.textContent = file.files?.[0]?.name ?? t("importNoFile");
    showProblem(null);
  });

  function showProblem(message: string | null): void {
    problem.textContent = message ?? "";
    problem.hidden = message === null;
  }

  const runImport = async (): Promise<void> => {
    const chosen = file.files?.[0];
    replace(report);
    if (chosen === undefined) {
      showProblem(t("importChooseFile"));
      choose.focus();
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
      replace(
        report,
        bar("success", [h("strong", { text: t("importDone") }), h("ul", {}, ...reportLines(result).map((line) => h("li", { text: line })))]),
      );
      report.firstElementChild?.setAttribute("role", "status");
      file.value = "";
      fileName.textContent = t("importNoFile");
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
  };

  replace(
    root,
    h("h1", { text: t("catBackup"), tabIndex: -1 }),
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
    h("div", { class: "row" }, h("label", { for: "import-mode", text: t("importModeLabel") }), mode, button(t("importButton"), () => void runImport())),
    problem,
    report,
  );

  return {
    render() {
      // Nothing here depends on stored data.
    },
  };
}
