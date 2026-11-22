// Learning: the Sent folders per account and the manual scan of sent mail.

import type { SettingsPatch } from "../../core/edit";
import { folderCandidates } from "../../core/folders";
import type { FolderRef, Settings } from "../../core/types";
import { t } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { wishOutcomeText } from "../../tb/stateText";
import { button, byId, description, fieldError, guard, h, learnMore, notice, reconcile, replace, setUnavailable, withMore } from "../dom";
import { endOfLocalDay } from "../fields";
import { chosenIn, hasFolder, sentFolders, withoutFolder } from "../model";
import type { AccountView, Model } from "../model";
import type { Section, Shell } from "../section";
import { folderEditors } from "./folderEditor";
import { scanStatusView } from "./scanStatus";

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

/** A Sent folder of the account itself is taken off by listing it as removed, any other folder by not listing it as added. */
function removePatch(account: AccountView, folder: FolderRef, settings: Settings): SettingsPatch {
  return hasFolder(account.sentDefaults, folder)
    ? { sentFoldersRemoved: [...withoutFolder(settings.sentFoldersRemoved, folder), folder] }
    : { sentFoldersAdded: withoutFolder(settings.sentFoldersAdded, folder) };
}

function addPatch(account: AccountView, folder: FolderRef, settings: Settings): SettingsPatch {
  return hasFolder(account.sentDefaults, folder)
    ? { sentFoldersRemoved: withoutFolder(settings.sentFoldersRemoved, folder) }
    : { sentFoldersAdded: [...withoutFolder(settings.sentFoldersAdded, folder), folder] };
}

export function learningSection(shell: Shell): Section {
  const root = byId("learning");
  /** The settings as last drawn. An Undo applies to them, not to what they were when the folder was removed. */
  let latest: Settings | null = null;
  const folders = h("div", { class: "accounts" });
  /** What the last change of the Sent folders did, with Undo. */
  const changed = notice();
  // The field itself is Thunderbird's own date control. What it expects and what an empty field means is said under it,
  // and belongs to the group of the two fields: each field is several stops of the keyboard, and the hint is read once.
  const from = h("input", { type: "date", id: "scan-from", oninput: () => rangeError.set(null) });
  const to = h("input", { type: "date", id: "scan-to", oninput: () => rangeError.set(null) });
  const rangeError = fieldError(to, "scan-range-error");
  const status = scanStatusView();
  /** What the scan means for protection that waits for it, or waited: said here too, directly under the scan, where it is started and cancelled. */
  const wishLine = h("p", { class: "wish-line", hidden: true, attrs: { role: "status" } });
  let accountCount = 0;
  let scanRunning = false;
  let starting = false;
  const start = button(t("scanStart"), () => {
    // Unavailable from the click on: a second click cannot ask for a second scan.
    starting = true;
    drawStart();
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
    }).finally(() => {
      starting = false;
      drawStart();
    });
  });

  /** While a scan runs, Cancel stands next to the button. Without an account there is nothing to scan, and the button says so. */
  function drawStart(): void {
    setUnavailable(start, false);
    if (accountCount === 0) {
      setUnavailable(start, true, t("noAccounts"));
    } else {
      setUnavailable(start, scanRunning || starting);
    }
    // The dates belong to the button: while it cannot start a scan they have nothing to limit.
    const idle = accountCount > 0 && !scanRunning;
    from.disabled = !idle;
    to.disabled = !idle;
  }

  /** Said in place of the folder lists while Thunderbird has no mail account. */
  const noAccounts = description(t("noAccounts"));
  const cancel = h("button", { type: "button", text: t("scanCancel"), hidden: true, onclick: () => void guard(() => send("cancelScan", {})) });

  replace(
    root,
    h("h1", { text: t("catLearning"), tabIndex: -1 }),
    h("p", { class: "lead" }, ...withMore(t("learningHint"), learnMore(t("catLearning"), t("learningMore")))),
    // What every user does here stands first. The folders, a list that grows with the accounts, follow.
    h("h2", { text: t("scanTitle"), id: "scan-title" }),
    description(t("scanHint")),
    h(
      "div",
      // The row of the scan is a group named by its heading and described by the hint under it.
      { class: "row", attrs: { role: "group", "aria-labelledby": "scan-title", "aria-describedby": "scan-dates-hint" } },
      h("label", { for: "scan-from", text: t("scanFrom") }),
      from,
      h("label", { for: "scan-to", text: t("scanTo") }),
      to,
      start,
      cancel,
    ),
    h("div", { class: "description", id: "scan-dates-hint", text: t("scanDatesHint") }),
    rangeError.element,
    status.element,
    wishLine,
    h("h2", { text: t("sentFoldersTitle") }),
    description(t("sentFoldersHint")),
    changed.element,
    noAccounts,
    folders,
  );

  return {
    render(model: Model) {
      const settings = model.settings;
      if (settings === null) {
        return;
      }
      latest = settings;
      reconcile(
        folders,
        folderEditors(model.accounts, {
          id: "sent",
          chosen: (account) => sentFolders(account, settings),
          candidates: (account) => folderCandidates("sent", account.folders, chosenIn(account, settings)),
          removable: () => true,
          fixedNote: "",
          onRemove: (account, folder) =>
            void guard(async () => {
              await update(removePatch(account, folder, settings));
              changed.show(
                t("folderRemoved", folder.name, account.name),
                async () => {
                  if (latest !== null) {
                    await update(addPatch(account, folder, latest));
                  }
                },
                t("folderRestored", folder.name, account.name),
              );
            }),
          onAdd: (account, folder) => {
            changed.clear();
            void guard(() => update(addPatch(account, folder, settings)));
          },
        }),
      );

      const running = model.status.scan?.running === true;
      noAccounts.hidden = model.accounts.length > 0;
      accountCount = model.accounts.length;
      scanRunning = running;
      drawStart();
      if (document.activeElement === cancel && !running) {
        // Cancel goes away with the scan: the keyboard goes back to the button that starts one. The focus moves
        // before Cancel is hidden, so that the focus ring moves with it.
        start.focus();
      }
      cancel.hidden = !running;
      status.update(model);
      const { waiting, outcome } = model.status.wish;
      // While it waits, the line also says what Cancel next to it would do to protection.
      const said = waiting ? `${t("wishWaiting")} ${t("wishWaitingCancel")}` : outcome === null ? "" : wishOutcomeText(outcome);
      if (wishLine.textContent !== said) {
        wishLine.textContent = said;
      }
      wishLine.hidden = said === "";
    },
    leave() {
      changed.clear();
    },
  };
}
