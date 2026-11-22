// A list of folders of one account with a remove button per row and a menu to add
// another folder. Used for Sent folders and for monitored folders.

import { t } from "../../tb/i18n";
import { addressed, description, focusNeighbor, h, option, removeButton } from "../dom";
import type { Keyed } from "../dom";
import type { AccountView, FolderView } from "../model";
import type { FolderRef } from "../../core/types";

export interface FolderEditorOptions {
  /** Prefix of the element ids, unique per list. */
  id: string;
  /** The folders of the account that are on the list. */
  chosen: (account: AccountView) => FolderRef[];
  /** The folders of the account the menu offers: those that can be right on this list and are not on it yet. */
  candidates: (account: AccountView) => FolderView[];
  /** False for a folder that is always on the list. */
  removable: (account: AccountView, folder: FolderRef) => boolean;
  /** Said next to a folder that cannot be removed. */
  fixedNote: string;
  onRemove: (account: AccountView, folder: FolderView) => void;
  onAdd: (account: AccountView, folder: FolderRef) => void;
}

/** One block per account. Blocks are rebuilt only when their folders change, so a pending choice survives a redraw. */
export function folderEditors(accounts: readonly AccountView[], options: FolderEditorOptions): Keyed[] {
  return accounts.map((account) => {
    const chosenRefs = options.chosen(account);
    // A folder that is stored stays listed, whatever its role, and a folder that no longer exists is named by its path.
    const chosen: FolderView[] = chosenRefs.map(
      (folder) => account.folders.find((candidate) => candidate.path === folder.path) ?? { ...folder, name: folder.path.replace(/^\//, ""), specialUse: [] },
    );
    const candidates = options.candidates(account);
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
        // Nothing can be added before a folder is chosen: the button says so by being unavailable.
        const add = h("button", {
          type: "button",
          text: t("addFolder"),
          disabled: true,
          onclick: () => {
            const folder = candidates.find((candidate) => candidate.path === select.value);
            if (folder !== undefined) {
              // The block is drawn again with the folder in it, and the button is unavailable again: the menu takes the focus.
              select.focus();
              options.onAdd(account, { accountId: folder.accountId, path: folder.path });
            }
          },
        });
        select.addEventListener("input", () => {
          add.disabled = select.value === "";
          // The menus of one column share one width: a longer name is shortened, and the tooltip has all of it.
          select.title = select.value === "" ? "" : (select.selectedOptions[0]?.textContent ?? "");
        });
        const rows = chosen.map((folder) => {
          const removable = options.removable(account, folder);
          const row = h(
            "li",
            {},
            h("span", { class: "name", text: folder.name, title: folder.path }),
            removable ? null : h("span", { class: "note", text: options.fixedNote }),
          );
          if (removable) {
            const remove = removeButton(t("removeNamedIn", folder.name, account.name), () => {
              // The row is about to go: the keyboard goes on with the next row, or with the menu for adding.
              focusNeighbor(row, candidates.length === 0 ? null : select);
              options.onRemove(account, folder);
            });
            remove.dataset.focus = `remove:${folder.path}`;
            row.appendChild(remove);
          }
          return row;
        });
        return h(
          "div",
          { class: "account-block" },
          h("h3", {}, ...addressed(account.name)),
          // Nothing listed and nothing to add is one line, not two that say the same of an account without a usable folder.
          rows.length === 0 && candidates.length === 0 ? description(t("noFolderUsable")) : null,
          // An empty list is one line of text, not an empty box.
          rows.length === 0
            ? candidates.length === 0
              ? null
              : description(t("noFolders"))
            : h("ul", { class: "plain-list", attrs: { "aria-label": account.name } }, ...rows),
          // Nothing left to offer is said in one line, not shown as an empty menu.
          candidates.length === 0
            ? rows.length === 0
              ? null
              : description(t("noFolderToAdd"))
            : h("div", { class: "row" }, h("label", { for: selectId, class: "visually-hidden", text: t("folderToAdd", account.name) }), select, add),
        );
      },
    };
  });
}
