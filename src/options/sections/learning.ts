// Learning: the Sent folders per account and the manual scan of sent mail.

import type { SettingsPatch } from "../../core/edit";
import { t } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { byId, description, fieldError, guard, h, learnMore, reconcile, replace } from "../dom";
import { endOfLocalDay } from "../fields";
import { hasFolder, sentFolders, withoutFolder } from "../model";
import type { Model } from "../model";
import type { Section, Shell } from "../section";
import { folderEditors } from "./folderEditor";
import { scanText } from "./scanText";

function update(patch: SettingsPatch): Promise<unknown> {
  return send("updateSettings", { patch });
}

/** Local midnight of a date input value (YYYY-MM-DD), or null when empty. */
function dayStart(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, day).getTime();
}

export function learningSection(shell: Shell): Section {
  const root = byId("learning");
  const folders = h("div", { class: "accounts" });
  const from = h("input", { type: "date", id: "scan-from", oninput: () => rangeError.set(null) });
  const to = h("input", { type: "date", id: "scan-to", oninput: () => rangeError.set(null) });
  const rangeError = fieldError(to, "scan-range-error");
  const progress = h("p", { class: "progress", attrs: { role: "status" } });
  const start = h("button", {
    type: "button",
    text: t("scanStart"),
    onclick: () =>
      void guard(async () => {
        const fromTime = dayStart(from.value);
        const toDay = dayStart(to.value);
        // messages.query includes toDate, so exclude midnight of the following day.
        const toTime = toDay === null ? null : endOfLocalDay(toDay);
        if (fromTime !== null && toTime !== null && fromTime >= toTime) {
          rangeError.set(t("scanRangeInvalid"));
          to.focus();
          return;
        }
        rangeError.set(null);
        await send("startScan", { from: fromTime, to: toTime });
        shell.startPolling();
        await shell.refresh();
      }),
  });
  const cancel = h("button", { type: "button", text: t("scanCancel"), hidden: true, onclick: () => void guard(() => send("cancelScan", {})) });

  replace(
    root,
    h("h1", { text: t("catLearning"), tabIndex: -1 }),
    description(t("learningHint"), learnMore(t("catLearning"), t("learningMore"))),
    h("h2", { text: t("sentFoldersTitle") }),
    description(t("sentFoldersHint")),
    folders,
    h("h2", { text: t("scanTitle") }),
    description(t("scanHint")),
    h(
      "div",
      { class: "row" },
      h("label", { for: "scan-from", text: t("scanFrom") }),
      from,
      h("label", { for: "scan-to", text: t("scanTo") }),
      to,
      start,
      cancel,
    ),
    rangeError.element,
    progress,
  );

  return {
    render(model: Model) {
      const settings = model.settings;
      if (settings === null) {
        return;
      }
      reconcile(
        folders,
        folderEditors(model.accounts, {
          id: "sent",
          chosen: (account) => sentFolders(account, settings),
          removable: () => true,
          fixedNote: "",
          onRemove: (account, folder) =>
            void guard(() =>
              update(
                hasFolder(account.sentDefaults, folder)
                  ? { sentFoldersRemoved: [...settings.sentFoldersRemoved, folder] }
                  : { sentFoldersAdded: withoutFolder(settings.sentFoldersAdded, folder) },
              ),
            ),
          onAdd: (account, folder) =>
            void guard(() =>
              update(
                hasFolder(account.sentDefaults, folder)
                  ? { sentFoldersRemoved: withoutFolder(settings.sentFoldersRemoved, folder) }
                  : { sentFoldersAdded: [...settings.sentFoldersAdded, folder] },
              ),
            ),
        }),
      );

      const scan = scanText(model);
      start.disabled = scan.running;
      cancel.hidden = !scan.running;
      if (progress.textContent !== scan.text) {
        progress.textContent = scan.text;
      }
    },
  };
}
