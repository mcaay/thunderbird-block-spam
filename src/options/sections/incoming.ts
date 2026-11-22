// Incoming mail: monitored folders, and what happens to mail without an AI verdict. The
// screening folder of each account is the dependent part of the option that moves such
// mail there: it stands under the menu, and only while that option is chosen. Under the
// menu the pane says what the choice does right now, and guards it with "scan first".

import type { SettingsPatch } from "../../core/edit";
import { folderCandidates, mayJoin, screeningFolderPaths } from "../../core/folders";
import { folderKey } from "../../core/ports";
import { aiHealth } from "../../core/stats";
import type { Settings } from "../../core/types";
import { t, tCode } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { beforeScanText, noVerdictOutcomeText, whereText } from "../../tb/stateText";
import { addressed, bar, button, byId, closeButton, description, dialog, errorText, guard, h, inlineStatus, notice, option, reconcile, replace, setUnavailable, whileBusy } from "../dom";
import { icon } from "../icons";
import { chosenIn, folderRef, folderView, forgetAccounts, hasFolder, monitoredFolders, withoutFolder } from "../model";
import type { Model } from "../model";
import { beforeScan, nothingLearned } from "../problems";
import type { Intent, Section, Shell } from "../section";
import { folderEditors } from "./folderEditor";
import { scanStatusView } from "./scanStatus";

function update(patch: SettingsPatch): Promise<unknown> {
  return send("updateSettings", { patch });
}

export function incomingSection(shell: Shell): Section {
  const root = byId("incoming");
  let model: Model | null = null;
  const monitored = h("div", { class: "accounts" });
  /** What the last change of the monitored folders did, with Undo. */
  const changed = notice();
  const screening = h("div", { class: "screening", attrs: { role: "group", "aria-labelledby": "screening-title" } });
  /** What "Create folder" did, per account. Kept across redraws. */
  const created = new Map<string, { text: string; ok: boolean }>();
  const noVerdict = h(
    "select",
    {
      id: "no-verdict",
      attrs: { "aria-describedby": "no-verdict-hint" },
      onchange: () => void guard(chooseNoVerdict),
    },
    option("leave", t("noVerdictLeave")),
    option("junk", t("noVerdictJunk")),
    option("screening", t("noVerdictScreening")),
  );
  /** Said while an account has no screening folder: its mail then stays where it is. */
  const noVerdictNote = h("div", { class: "option-note", id: "no-verdict-note", hidden: true, attrs: { role: "status" } });
  /**
   * What the option "Move it to the screening folder" needs: the folder of each account. It is shown only while that
   * option is chosen, so that nothing can be set here that has no effect. The stored folders stay and come back with it.
   */
  const dependent = h(
    "div",
    { class: "sub-option screening-folders", hidden: true },
    h("h3", { text: t("screeningTitle"), id: "screening-title" }),
    // What a screening folder is stands with the folders, where the option that uses them is chosen.
    description(t("screeningHint")),
    noVerdictNote,
    screening,
  );
  /** What the stored choice does right now. Shown while no AI service is available: then it decides about every message from an unknown sender. */
  const nowLine = h("div", { class: "description", id: "no-verdict-now", hidden: true });
  /** Said while a choice waits for the scan: which one, that it takes effect by itself, and the way to call it off. */
  const choiceText = h("span", { id: "no-verdict-wish-text" });
  const choiceCancel = button(
    t("noVerdictWishCancel"),
    () =>
      void guard(async () => {
        // The note goes away with the wish: the keyboard goes back to the menu it belongs to.
        noVerdict.focus();
        await send("clearNoVerdictWish", {});
        await shell.refresh();
      }),
    "small",
  );
  choiceCancel.setAttribute("aria-describedby", "no-verdict-wish-text");
  const choiceNote = h("div", { class: "option-note plain", id: "no-verdict-wish", hidden: true, attrs: { role: "status" } }, icon("clock"), choiceText, choiceCancel);
  /** What became of a choice that waited for the scan. It stays until it is dismissed, the choice is made by hand or the pane is left. */
  const choiceOutcome = h("div", { class: "notice", tabIndex: -1, attrs: { role: "group" } });
  /** While the sent mail is not scanned and the choice moves mail: what happens to mail from people the user writes to, with the button that starts the scan. */
  const unscanned = h("div", { class: "notice", attrs: { role: "status" } });
  /** The scan as it runs, under the warning that offers it. */
  const scanStatus = scanStatusView();
  /** Said in place of the lists while Thunderbird has no mail account. */
  const noAccounts = description(t("noAccounts"));
  /** The accounts whose folder is being created right now. */
  const creating = new Set<string>();

  replace(
    root,
    h("h1", { text: t("catIncoming"), tabIndex: -1 }),
    h("p", { class: "lead", text: t("incomingHint") }),
    h("h2", { text: t("monitoredTitle") }),
    description(t("monitoredHint")),
    changed.element,
    noAccounts,
    monitored,
    h("h2", { text: t("noVerdictTitle") }),
    // First which mail this is, then the question, then what the chosen answer needs.
    h("div", { class: "description", id: "no-verdict-hint", text: t("noVerdictScope") }),
    h("div", { class: "row" }, h("label", { for: "no-verdict", text: t("noVerdictLabel") }), noVerdict),
    // Directly under the menu, and only while the option that uses them is chosen.
    dependent,
  );

  function createFolder(accountId: string): void {
    if (creating.has(accountId)) {
      return;
    }
    // Creating a folder needs an optional permission, which Thunderbird only grants
    // while the click is being handled: nothing may be awaited before the request.
    const request = browser.permissions.request({ permissions: ["accountsFolders"] });
    creating.add(accountId);
    void (async () => {
      try {
        if (!(await request)) {
          created.set(accountId, { text: t("permissionDeclined"), ok: false });
        } else {
          forgetAccounts();
          const { path } = await send("createScreeningFolder", { accountId });
          await shell.refresh();
          const name = model === null ? path.replace(/^\//, "") : folderView(model, { accountId, path }).name;
          created.set(accountId, { text: t("screeningCreated", name), ok: true });
        }
      } catch (error) {
        created.set(accountId, { text: errorText(error), ok: false });
      }
      creating.delete(accountId);
      if (model !== null) {
        drawScreening(model);
      }
    })();
  }

  function drawScreening(current: Model): void {
    const settings = current.settings;
    if (settings === null) {
      return;
    }
    const folderName = t("screeningFolderName");
    reconcile(
      screening,
      current.accounts.map((account) => {
        const chosen = settings.screeningFolders.find((folder) => folder.accountId === account.id) ?? null;
        const others = settings.screeningFolders.filter((folder) => folder.accountId !== account.id);
        const roles = chosenIn(account, settings);
        // Only folders that can be right here are offered. The folder that is stored stays in the menu, whatever its role.
        const offered = account.folders.filter(
          (folder) => (chosen !== null && folderKey(chosen) === folderKey(folder)) || (!hasFolder(roles.screening, folder) && mayJoin("screening", folder, roles)),
        );
        const candidates = folderCandidates("screening", account.folders, roles);
        // The folder the button makes: it may exist already, at the top of the account or inside its Inbox.
        const places = screeningFolderPaths(folderName, account.inboxes, account.id);
        const existing = account.folders.find((folder) => places.includes(folder.path)) ?? null;
        const isChosen = chosen !== null && places.includes(chosen.path);
        const usable = existing === null || isChosen || mayJoin("screening", existing, roles);
        const note = created.get(account.id);
        return {
          key: account.id,
          signature: JSON.stringify([account.name, offered, candidates.length, chosen, note ?? null, existing?.path ?? null, isChosen, usable, creating.has(account.id)]),
          build: () => {
            const id = `screening-${account.id}`;
            const select = h(
              "select",
              {
                id,
                // The whole name of the chosen folder, for when the menu is too narrow for it.
                title: chosen === null ? undefined : t("chosenFolder", folderView(current, chosen).name),
                attrs: { "data-focus": "select", "aria-label": t("screeningFor", account.name) },
                onchange: () => {
                  const folder = account.folders.find((candidate) => candidate.path === select.value);
                  created.delete(account.id);
                  void guard(() => update({ screeningFolders: folder === undefined ? others : [...others, folderRef(folder)] }));
                },
              },
              option("", t("screeningNone"), chosen === null),
              // A stored folder that no longer exists is named by its path, so that the menu shows what is stored.
              chosen !== null && !offered.some((folder) => folderKey(folder) === folderKey(chosen)) ? option(chosen.path, folderView(current, chosen).name, true) : null,
              ...offered.map((folder) => option(folder.path, folder.name, chosen !== null && folderKey(chosen) === folderKey(folder))),
            );
            const status = inlineStatus();
            if (note !== undefined) {
              status.set(note.text, note.ok ? "ok" : "error");
            }
            const existsElsewhere = existing !== null && !isChosen;
            const create = button(t(existsElsewhere ? "screeningUse" : "screeningCreate", folderName), () => createFolder(account.id));
            create.dataset.focus = "create";
            create.setAttribute("aria-label", t(existsElsewhere ? "screeningUseFor" : "screeningCreateFor", folderName, account.name));
            // The button is unavailable when its folder is the screening folder already, or cannot be one.
            if (isChosen) {
              setUnavailable(create, true, t("screeningIsChosen", folderName));
            } else if (!usable) {
              setUnavailable(create, true, tCode("invalid", "folder-role"));
            } else if (creating.has(account.id)) {
              setUnavailable(create, true);
            }
            return h(
              "div",
              { class: "screening-row" },
              h("label", { for: id }, ...addressed(account.name)),
              // Nothing to choose from is said in one line, not shown as a menu with one item.
              chosen === null && candidates.length === 0 ? h("span", { class: "description no-candidate", text: t("screeningNoCandidate") }) : select,
              create,
              status.element,
            );
          },
        };
      }),
    );
  }

  /**
   * The menu was changed. Leaving mail where it is saves at once, like every menu. A choice that starts moving mail
   * without a verdict while protection is on and the sent mail was not scanned asks first: until the scan, mail from
   * people the user already writes to would be moved. "Scan first" keeps the choice with the background: the stored
   * setting stays what it was and changes by itself when the scan has finished. While protection is off nothing is
   * asked here: it is asked when protection is switched on. While mail is moved already (the user said "choose
   * anyway"), the other folder is chosen without a second question.
   */
  async function chooseNoVerdict(): Promise<void> {
    const chosen = noVerdict.value as Settings["noVerdictAction"];
    const current = model;
    const settings = current?.settings;
    if (current === null || settings === null || settings === undefined) {
      return;
    }
    if (chosen === "leave" || !settings.protection || settings.noVerdictAction !== "leave") {
      await update({ noVerdictAction: chosen });
      return;
    }
    // Asked of the background at this moment: a scan can have started or ended since the page last heard of it.
    const status = await send("getStatus", {}).catch(() => current.status);
    const scanning = status.scan?.running === true;
    if (!scanning && !nothingLearned({ ...current, status })) {
      await update({ noVerdictAction: chosen });
      return;
    }
    // Nothing changes before the answer, and the menu says so while the question is open.
    noVerdict.value = settings.noVerdictAction;
    const where = whereText(chosen);
    const choice = await dialog(
      scanning
        ? { title: t("scanWaitTitle"), body: [t("noVerdictScanWaitText", where)], confirmLabel: t("scanWait"), extraLabel: t("noVerdictAnyway"), focus: "confirm" }
        : { title: t("scanFirstTitle"), body: [t("scanFirstMoved", where), t("noVerdictScanFirstText")], confirmLabel: t("scanFirst"), extraLabel: t("noVerdictAnyway"), focus: "confirm" },
    );
    if (choice === "confirm") {
      // The menu keeps showing the stored value, and the note under it says which choice waits.
      await send("noVerdictAfterScan", { action: chosen });
      shell.startPolling();
      await shell.refresh();
    } else if (choice === "extra") {
      noVerdict.value = chosen;
      await update({ noVerdictAction: chosen });
    }
  }

  /** The label of an option of the menu, for the sentence that names it. */
  function optionLabel(action: Settings["noVerdictAction"]): string {
    return t(action === "junk" ? "noVerdictJunk" : action === "screening" ? "noVerdictScreening" : "noVerdictLeave");
  }

  /** Everything under the menu that follows from the state: what the choice does now, a choice that waits, what became of it, and the warning before the scan. */
  function drawChoice(current: Model): void {
    const settings = current.settings;
    if (settings === null) {
      return;
    }
    const action = settings.noVerdictAction;
    const wish = current.status.wish;
    // While a service is available the choice is only the fallback, and the sentence above the menu says when it applies.
    const now =
      aiHealth(current.accessPoints, Date.now()).working > 0
        ? ""
        : settings.protection || action === "leave"
          ? tCode("noVerdictNow", action)
          : tCode("noVerdictNowOff", action);
    if (nowLine.textContent !== now) {
      nowLine.textContent = now;
    }
    nowLine.hidden = now === "";
    // A hidden line would still be read as part of the description, so it is named only while it shows.
    noVerdict.setAttribute("aria-describedby", now === "" ? "no-verdict-hint" : "no-verdict-hint no-verdict-now");

    const waiting = wish.noVerdict === null ? "" : t("noVerdictWaiting", optionLabel(wish.noVerdict));
    if (choiceText.textContent !== waiting) {
      choiceText.textContent = waiting;
    }
    if (waiting === "" && choiceNote.contains(document.activeElement)) {
      // The note goes away with the wish (the scan has ended): the keyboard goes back to the menu.
      noVerdict.focus();
    }
    choiceNote.hidden = waiting === "";

    const outcome = wish.noVerdictOutcome;
    const outcomeSignature = outcome === null ? "" : JSON.stringify(outcome);
    if (choiceOutcome.dataset.signature !== outcomeSignature) {
      choiceOutcome.dataset.signature = outcomeSignature;
      if (outcome === null) {
        choiceOutcome.removeAttribute("aria-label");
        replace(choiceOutcome);
      } else {
        const text = noVerdictOutcomeText(outcome, outcome.action);
        const box = bar(outcome.kind === "on" ? "success" : "warning", [text], [
          closeButton(() =>
            void guard(async () => {
              // The bar goes away: the keyboard goes back to the menu it was about.
              noVerdict.focus();
              await send("clearNoVerdictWish", {});
              await shell.refresh();
            }),
          ),
        ]);
        box.setAttribute("role", "status");
        choiceOutcome.setAttribute("aria-label", text);
        replace(choiceOutcome, box);
      }
    }

    // The warning of the Overview stands here too while the choice moves mail: one cause, the same sentence.
    const effects = beforeScan(current);
    const scanning = current.status.scan?.running === true;
    const warning = effects === null || effects.moved === null ? "" : beforeScanText(effects, settings.protection);
    const warningSignature = warning === "" ? "" : JSON.stringify([warning, scanning]);
    scanStatus.update(current);
    if (unscanned.dataset.signature !== warningSignature) {
      const held = unscanned.contains(document.activeElement);
      unscanned.dataset.signature = warningSignature;
      const scanButton: HTMLButtonElement = button(t("scanStart"), () =>
        void whileBusy(scanButton, () =>
          guard(async () => {
            await send("startScan", { from: null, to: null });
            shell.startPolling();
            await shell.refresh();
          }),
        ),
      );
      if (scanning) {
        // The scan is running: its progress stands under the warning, and the button has nothing to start.
        setUnavailable(scanButton, true, t("errorScanRunning"));
      }
      replace(unscanned, warning === "" ? null : bar("warning", [warning], [scanButton]), warning === "" ? null : scanStatus.element);
      if (held && !unscanned.contains(document.activeElement)) {
        // The warning went away with the scan, or its button was drawn anew: the keyboard stays here, or goes back to the menu.
        (unscanned.querySelector<HTMLElement>("button") ?? noVerdict).focus();
      }
    }
  }

  function drawNoVerdictNote(current: Model): void {
    const settings = current.settings;
    if (settings === null) {
      return;
    }
    const without = current.accounts.filter((account) => !settings.screeningFolders.some((folder) => folder.accountId === account.id)).map((account) => account.name);
    const show = (settings.noVerdictAction === "screening" || current.status.wish.noVerdict === "screening") && without.length > 0;
    const signature = show ? without.join("\n") : "";
    if (noVerdictNote.dataset.signature !== signature) {
      noVerdictNote.dataset.signature = signature;
      replace(noVerdictNote, show ? icon("warning") : null, show ? h("span", {}, ...addressed(t("noVerdictNoFolder", without.join(", ")))) : null);
    }
    noVerdictNote.hidden = !show;
  }

  // What follows from the choice stands directly under its menu, before the part that depends on one option:
  // what it does right now, a choice that waits for the scan, what became of it, and the warning before the scan.
  noVerdict.parentElement?.after(nowLine, choiceNote, choiceOutcome, unscanned);

  return {
    render(next: Model) {
      model = next;
      const settings = next.settings;
      if (settings === null) {
        return;
      }
      noVerdict.value = settings.noVerdictAction;
      drawChoice(next);
      noAccounts.hidden = next.accounts.length > 0;
      // The folders belong to the one option that uses them. Without a mail account there is no folder to choose either.
      // A choice of that option that waits for the scan shows them as well, so that the folders can be chosen meanwhile.
      const uses = (settings.noVerdictAction === "screening" || next.status.wish.noVerdict === "screening") && next.accounts.length > 0;
      if (!uses && dependent.contains(document.activeElement)) {
        // The part goes away with the option: the keyboard goes back to the menu it depends on.
        noVerdict.focus();
      }
      dependent.hidden = !uses;
      drawNoVerdictNote(next);
      reconcile(
        monitored,
        folderEditors(next.accounts, {
          id: "monitored",
          chosen: (account) => monitoredFolders(account, settings),
          candidates: (account) => folderCandidates("monitored", account.folders, chosenIn(account, settings)),
          removable: (account, folder) => !hasFolder(account.inboxes, folder),
          fixedNote: t("monitoredAlways"),
          onRemove: (account, folder) =>
            void guard(async () => {
              await update({ monitoredFoldersAdded: withoutFolder(settings.monitoredFoldersAdded, folder) });
              changed.show(
                t("folderRemoved", folder.name, account.name),
                async () => {
                  // Applied to the folders as they are now, not as they were when this one was removed.
                  const current = model?.settings;
                  if (current !== null && current !== undefined) {
                    await update({ monitoredFoldersAdded: [...withoutFolder(current.monitoredFoldersAdded, folder), folderRef(folder)] });
                  }
                },
                t("folderRestored", folder.name, account.name),
              );
            }),
          onAdd: (_account, folder) => {
            changed.clear();
            void guard(() => update({ monitoredFoldersAdded: [...settings.monitoredFoldersAdded, folder] }));
          },
        }),
      );
      drawScreening(next);
    },
    reveal(intent: Intent) {
      if (intent.kind === "screening") {
        // The menu of the account the warning was about, or else the option the folders depend on.
        (document.getElementById(`screening-${intent.accountId}`) ?? noVerdict).focus();
      } else if (intent.kind === "no-verdict") {
        // A sentence elsewhere named this setting: the menu takes the focus.
        noVerdict.scrollIntoView({ block: "center" });
        noVerdict.focus();
      }
    },
    leave() {
      changed.clear();
      // What became of a choice that waited for the scan was said here and is history once the pane is left.
      const wish = model?.status.wish;
      if (wish !== undefined && wish.noVerdictOutcome !== null && wish.noVerdict === null) {
        void send("clearNoVerdictWish", {})
          .then(() => shell.refresh())
          .catch(() => undefined);
      }
    },
  };
}
