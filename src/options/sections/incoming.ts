// Incoming mail: monitored folders, what happens to mail without an AI verdict, and
// the screening folder of each account.

import type { SettingsPatch } from "../../core/edit";
import { folderKey } from "../../core/ports";
import type { Settings } from "../../core/types";
import { t } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { byId, description, errorText, guard, h, inlineStatus, option, reconcile, replace } from "../dom";
import { folderRef, folderView, forgetAccounts, hasFolder, monitoredFolders, withoutFolder } from "../model";
import type { Model } from "../model";
import type { Intent, Section, Shell } from "../section";
import { folderEditors } from "./folderEditor";

function update(patch: SettingsPatch): Promise<unknown> {
  return send("updateSettings", { patch });
}

export function incomingSection(shell: Shell): Section {
  const root = byId("incoming");
  let model: Model | null = null;
  const monitored = h("div", { class: "accounts" });
  const screening = h("div", { class: "screening" });
  /** What "Create folder" did, per account. Kept across redraws. */
  const created = new Map<string, { text: string; ok: boolean }>();
  const noVerdict = h(
    "select",
    { id: "no-verdict", onchange: () => void guard(() => update({ noVerdictAction: noVerdict.value as Settings["noVerdictAction"] })) },
    option("leave", t("noVerdictLeave")),
    option("junk", t("noVerdictJunk")),
    option("screening", t("noVerdictScreening")),
  );

  replace(
    root,
    h("h1", { text: t("catIncoming"), tabIndex: -1 }),
    description(t("incomingHint")),
    h("h2", { text: t("monitoredTitle") }),
    description(t("monitoredHint")),
    monitored,
    h("h2", { text: t("noVerdictTitle") }),
    h("div", { class: "row" }, h("label", { for: "no-verdict", text: t("noVerdictLabel") }), noVerdict),
    h("h2", { text: t("screeningTitle") }),
    description(t("screeningHint")),
    screening,
  );

  function createFolder(accountId: string): void {
    // Creating a folder needs an optional permission, which Thunderbird only grants
    // while the click is being handled: nothing may be awaited before the request.
    const request = browser.permissions.request({ permissions: ["accountsFolders"] });
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
    reconcile(
      screening,
      current.accounts.map((account) => {
        const chosen = settings.screeningFolders.find((folder) => folder.accountId === account.id) ?? null;
        const others = settings.screeningFolders.filter((folder) => folder.accountId !== account.id);
        const note = created.get(account.id);
        return {
          key: account.id,
          signature: JSON.stringify([account.name, account.folders, chosen, note ?? null]),
          build: () => {
            const id = `screening-${account.id}`;
            const select = h(
              "select",
              {
                id,
                attrs: { "data-focus": "select" },
                onchange: () => {
                  const folder = account.folders.find((candidate) => candidate.path === select.value);
                  created.delete(account.id);
                  void guard(() => update({ screeningFolders: folder === undefined ? others : [...others, folderRef(folder)] }));
                },
              },
              option("", t("screeningNone"), chosen === null),
              ...account.folders.map((folder) => option(folder.path, folder.name, chosen !== null && folderKey(chosen) === folderKey(folder))),
            );
            const status = inlineStatus();
            if (note !== undefined) {
              status.set(note.text, note.ok ? "ok" : "error");
            }
            return h(
              "div",
              { class: "screening-row" },
              h("label", { for: id, text: account.name }),
              select,
              h("button", { type: "button", text: t("screeningCreate"), attrs: { "data-focus": "create", "aria-label": t("screeningCreateFor", account.name) }, onclick: () => createFolder(account.id) }),
              status.element,
            );
          },
        };
      }),
    );
  }

  return {
    render(next: Model) {
      model = next;
      const settings = next.settings;
      if (settings === null) {
        return;
      }
      noVerdict.value = settings.noVerdictAction;
      reconcile(
        monitored,
        folderEditors(next.accounts, {
          id: "monitored",
          chosen: (account) => monitoredFolders(account, settings),
          removable: (account, folder) => !hasFolder(account.inboxes, folder),
          fixedNote: t("monitoredAlways"),
          onRemove: (_account, folder) => void guard(() => update({ monitoredFoldersAdded: withoutFolder(settings.monitoredFoldersAdded, folder) })),
          onAdd: (_account, folder) => void guard(() => update({ monitoredFoldersAdded: [...settings.monitoredFoldersAdded, folder] })),
        }),
      );
      drawScreening(next);
    },
    reveal(intent: Intent) {
      if (intent.kind === "screening") {
        document.getElementById(`screening-${intent.accountId}`)?.focus();
      }
    },
  };
}
