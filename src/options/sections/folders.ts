// Learning (Sent folders and the manual scan) and Incoming mail (monitored folders,
// the "no AI verdict" setting, screening folders and the scope of new entries).

import type { SettingsPatch } from "../../core/edit";
import { folderKey } from "../../core/ports";
import type { FolderRef, Settings } from "../../core/types";
import { t } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { button, byId, guard, h, option, replace, toast } from "../dom";
import { folderLabel, forgetAccounts, hasFolder, monitoredFolders, sentFolders, withoutFolder } from "../model";
import type { AccountView, Model } from "../model";
import type { Section } from "../section";

function update(patch: SettingsPatch): Promise<unknown> {
  return send("updateSettings", { patch });
}

/** A list of folders with remove buttons and a select to add another folder of the account. */
function folderEditor(
  account: AccountView,
  chosen: readonly FolderRef[],
  removable: (folder: FolderRef) => boolean,
  onRemove: (folder: FolderRef) => void,
  onAdd: (folder: FolderRef) => void,
): HTMLElement {
  const candidates = account.folders.filter((folder) => !hasFolder(chosen, folder));
  const select = h(
    "select",
    {},
    option("", t("chooseFolder")),
    ...candidates.map((folder) => option(folder.path, folderLabel(folder))),
  );
  return h(
    "div",
    { class: "folder-editor" },
    chosen.length === 0
      ? h("p", { class: "hint", text: t("noFolders") })
      : h(
          "ul",
          { class: "chips" },
          ...chosen.map((folder) =>
            h("li", {}, h("span", { text: folderLabel(folder) }), removable(folder) ? button("×", () => onRemove(folder), "chip-remove") : null),
          ),
        ),
    h(
      "div",
      { class: "row" },
      select,
      button(t("addFolder"), () => {
        const folder = candidates.find((candidate) => candidate.path === select.value);
        if (folder !== undefined) {
          onAdd(folder);
        }
      }),
    ),
  );
}

/** Local midnight of a date input value (YYYY-MM-DD), or null when empty. */
function dayStart(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, day).getTime();
}

export function learningSection(onScanStarted: () => void): Section {
  const root = byId("learning");
  const folders = h("div");
  const from = h("input", { type: "date", id: "scan-from" });
  const to = h("input", { type: "date", id: "scan-to" });
  const progress = h("p", { class: "progress" });
  const start = button(
    t("scanStart"),
    () =>
      void guard(async () => {
        const fromTime = dayStart(from.value);
        const toDay = dayStart(to.value);
        // The end date is inclusive: scan up to the start of the following day.
        const toTime = toDay === null ? null : new Date(toDay).setDate(new Date(toDay).getDate() + 1);
        if (fromTime !== null && toTime !== null && fromTime >= toTime) {
          toast(t("scanRangeInvalid"), "error");
          return;
        }
        await send("startScan", { from: fromTime, to: toTime });
        onScanStarted();
      }),
    "primary",
  );
  const cancel = button(t("cancel"), () => void guard(() => send("cancelScan", {})));

  replace(
    root,
    h("h2", { text: t("sectionLearning") }),
    h("p", { class: "hint", text: t("learningHint") }),
    h("h3", { text: t("sentFoldersTitle") }),
    h("p", { class: "hint", text: t("sentFoldersHint") }),
    folders,
    h("h3", { text: t("scanTitle") }),
    h("p", { class: "hint", text: t("scanHint") }),
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
    progress,
  );

  return {
    render(model: Model) {
      const settings = model.settings;
      if (settings === null) {
        return;
      }
      replace(
        folders,
        ...model.accounts.map((account) => {
          const chosen = sentFolders(account, settings);
          return h(
            "div",
            { class: "account" },
            h("h4", { text: account.name }),
            folderEditor(
              account,
              chosen,
              () => true,
              (folder) =>
                void guard(() =>
                  update(
                    hasFolder(account.sentDefaults, folder)
                      ? { sentFoldersRemoved: [...settings.sentFoldersRemoved, folder] }
                      : { sentFoldersAdded: withoutFolder(settings.sentFoldersAdded, folder) },
                  ),
                ),
              (folder) =>
                void guard(() =>
                  update(
                    hasFolder(account.sentDefaults, folder)
                      ? { sentFoldersRemoved: withoutFolder(settings.sentFoldersRemoved, folder) }
                      : { sentFoldersAdded: [...settings.sentFoldersAdded, folder] },
                  ),
                ),
            ),
          );
        }),
      );

      const scan = model.status.scan;
      const running = scan?.running === true;
      start.disabled = running;
      cancel.hidden = !running;
      if (scan === null) {
        progress.textContent = "";
      } else if (running) {
        progress.textContent = t(
          "scanRunning",
          scan.folderIndex,
          scan.folderCount,
          scan.folder === null ? "" : folderLabel(scan.folder),
          scan.scanned,
          scan.added,
        );
      } else {
        const summary = t(scan.cancelled ? "scanCancelled" : "scanDone", scan.scanned, scan.added);
        progress.textContent = scan.errors.length > 0 ? `${summary} ${t("scanErrors", scan.errors.join("; "))}` : summary;
      }
    },
  };
}

export function incomingSection(): Section {
  const root = byId("incoming");
  const monitored = h("div");
  const screening = h("div");
  const noVerdict = h(
    "select",
    { id: "no-verdict", onchange: () => void guard(() => update({ noVerdictAction: noVerdict.value as Settings["noVerdictAction"] })) },
    option("leave", t("noVerdictLeave")),
    option("junk", t("noVerdictJunk")),
    option("screening", t("noVerdictScreening")),
  );
  const scope = h(
    "select",
    { id: "new-scope", onchange: () => void guard(() => update({ newEntryScope: scope.value as Settings["newEntryScope"] })) },
    option("shared", t("scopeShared")),
    option("account", t("scopePerAccount")),
  );

  replace(
    root,
    h("h2", { text: t("sectionIncoming") }),
    h("p", { class: "hint", text: t("incomingHint") }),
    h("h3", { text: t("monitoredTitle") }),
    h("p", { class: "hint", text: t("monitoredHint") }),
    monitored,
    h("h3", { text: t("noVerdictTitle") }),
    h("div", { class: "row" }, h("label", { for: "no-verdict", text: t("noVerdictLabel") }), noVerdict),
    h("h3", { text: t("screeningTitle") }),
    h("p", { class: "hint", text: t("screeningHint") }),
    screening,
    h("h3", { text: t("newEntriesTitle") }),
    h("div", { class: "row" }, h("label", { for: "new-scope", text: t("newEntriesLabel") }), scope),
    h("p", { class: "hint", text: t("newEntriesHint") }),
  );

  return {
    render(model: Model) {
      const settings = model.settings;
      if (settings === null) {
        return;
      }
      noVerdict.value = settings.noVerdictAction;
      scope.value = settings.newEntryScope;

      replace(
        monitored,
        ...model.accounts.map((account) =>
          h(
            "div",
            { class: "account" },
            h("h4", { text: account.name }),
            folderEditor(
              account,
              monitoredFolders(account, settings),
              (folder) => !hasFolder(account.inboxes, folder),
              (folder) => void guard(() => update({ monitoredFoldersAdded: withoutFolder(settings.monitoredFoldersAdded, folder) })),
              (folder) => void guard(() => update({ monitoredFoldersAdded: [...settings.monitoredFoldersAdded, folder] })),
            ),
          ),
        ),
      );

      replace(
        screening,
        ...model.accounts.map((account) => {
          const current = settings.screeningFolders.find((folder) => folder.accountId === account.id) ?? null;
          const others = settings.screeningFolders.filter((folder) => folder.accountId !== account.id);
          const select = h(
            "select",
            {
              onchange: () => {
                const folder = account.folders.find((candidate) => candidate.path === select.value);
                void guard(() => update({ screeningFolders: folder === undefined ? others : [...others, folder] }));
              },
            },
            option("", t("screeningNone"), current === null),
            ...account.folders.map((folder) => option(folder.path, folderLabel(folder), current !== null && folderKey(current) === folderKey(folder))),
          );
          return h(
            "div",
            { class: "row account-row" },
            h("span", { class: "account-name", text: account.name }),
            select,
            button(t("screeningCreate"), () =>
              void guard(async () => {
                // Creating a folder needs an optional permission, requested here on the click.
                const granted = await browser.permissions.request({ permissions: ["accountsFolders"] });
                if (!granted) {
                  toast(t("permissionDeclined"), "error");
                  return;
                }
                forgetAccounts();
                const { path } = await send("createScreeningFolder", { accountId: account.id });
                toast(t("screeningCreated", path.replace(/^\//, "")));
              }),
            ),
          );
        }),
      );
    },
  };
}
