// A list of folders of one account with a remove button per row and a select to add
// another folder. Used for Sent folders and for monitored folders.

import { t } from "../../tb/i18n";
import { h, iconButton, option } from "../dom";
import type { Keyed } from "../dom";
import { hasFolder } from "../model";
import type { AccountView, FolderView } from "../model";
import type { FolderRef } from "../../core/types";

export interface FolderEditorOptions {
  /** Prefix of the element ids, unique per list. */
  id: string;
  /** The folders of the account that are on the list. */
  chosen: (account: AccountView) => FolderRef[];
  /** False for a folder that is always on the list. */
  removable: (account: AccountView, folder: FolderRef) => boolean;
  /** Said next to a folder that cannot be removed. */
  fixedNote: string;
  onRemove: (account: AccountView, folder: FolderRef) => void;
  onAdd: (account: AccountView, folder: FolderRef) => void;
}

/** One block per account. Blocks are rebuilt only when their folders change, so a pending choice survives a redraw. */
export function folderEditors(accounts: readonly AccountView[], options: FolderEditorOptions): Keyed[] {
  return accounts.map((account) => {
    const chosenRefs = options.chosen(account);
    const chosen: FolderView[] = chosenRefs.map(
      (folder) => account.folders.find((candidate) => candidate.path === folder.path) ?? { ...folder, name: folder.path.replace(/^\//, "") },
    );
    const candidates = account.folders.filter((folder) => !hasFolder(chosenRefs, folder));
    return {
      key: account.id,
      signature: JSON.stringify([account.name, chosen, candidates, chosen.map((folder) => options.removable(account, folder))]),
      build: () => {
        const selectId = `${options.id}-add-${account.id}`;
        const select = h(
          "select",
          { id: selectId, attrs: { "data-focus": "select" } },
          option("", t("chooseFolder")),
          ...candidates.map((folder) => option(folder.path, folder.name)),
        );
        return h(
          "div",
          { class: "account-block" },
          h("h3", { text: account.name }),
          h(
            "ul",
            { class: "listbox", attrs: { "aria-label": account.name } },
            ...(chosen.length === 0
              ? [h("li", { class: "empty", text: t("noFolders") })]
              : chosen.map((folder) => {
                  const removable = options.removable(account, folder);
                  const remove = removable ? iconButton("close", t("removeNamed", folder.name), () => options.onRemove(account, folder), "quiet") : null;
                  if (remove !== null) {
                    remove.dataset.focus = `remove:${folder.path}`;
                  }
                  return h(
                    "li",
                    {},
                    h("span", { class: "name", text: folder.name, title: folder.path }),
                    removable ? null : h("span", { class: "note", text: options.fixedNote }),
                    remove,
                  );
                })),
          ),
          candidates.length === 0
            ? null
            : h(
                "div",
                { class: "row" },
                h("label", { for: selectId, class: "visually-hidden", text: t("folderToAdd", account.name) }),
                select,
                h("button", {
                  type: "button",
                  text: t("addFolder"),
                  attrs: { "data-focus": "add" },
                  onclick: () => {
                    const folder = candidates.find((candidate) => candidate.path === select.value);
                    if (folder === undefined) {
                      select.focus();
                    } else {
                      options.onAdd(account, { accountId: folder.accountId, path: folder.path });
                    }
                  },
                }),
              ),
        );
      },
    };
  });
}
