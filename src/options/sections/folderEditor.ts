// A list of folders of one account with a remove button per row and a menu to add
// another folder. Used for Sent folders and for monitored folders.

import { t } from "../../tb/i18n";
import { addressed, checkRow, description, h, named, option, removeButton } from "../dom";
import type { Keyed, RemovedRows } from "../dom";
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
  /** The folders that were removed and still stand in their place as quiet rows with Undo. */
  removed: RemovedRows;
  /** `row` is the row of the folder: it is handed to `removed`, which keeps it in its place. */
  onRemove: (account: AccountView, folder: FolderView, row: HTMLElement) => void;
  onAdd: (account: AccountView, folder: FolderRef) => void;
  /** A switch for the whole account, under its name. While it is off, a sentence stands in place of the folders. */
  accountSwitch?: {
    label: string;
    on: (account: AccountView) => boolean;
    /** Said in place of the folders of an account that is switched off. */
    offNote: string;
    onChange: (account: AccountView, on: boolean) => void;
  };
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
    // A folder that was removed keeps its place in the list as a quiet row, until the next other action in the list.
    const prefix = `${account.id}\n`;
    const keys = options.removed.order(chosen.map((folder) => prefix + folder.path), prefix);
    return {
      key: account.id,
      signature: JSON.stringify([
        account.name,
        chosen,
        candidates,
        chosen.map((folder) => options.removable(account, folder)),
        keys,
        options.removed.signature(prefix),
        options.accountSwitch?.on(account) ?? null,
      ]),
      build: () => {
        const accountSwitch = options.accountSwitch;
        const on = accountSwitch === undefined || accountSwitch.on(account);
        let switchRow: HTMLElement | null = null;
        if (accountSwitch !== undefined) {
          const check = checkRow(`${options.id}-on-${account.id}`, accountSwitch.label, (checked) => accountSwitch.onChange(account, checked));
          check.input.checked = on;
          // The block is drawn again when the switch changes: the focus goes back to the switch.
          check.input.dataset.focus = "switch";
          // Every account has such a switch: the name says whose it is.
          named(check.input, account.name, accountSwitch.label);
          switchRow = check.row;
        }
        if (accountSwitch !== undefined && !on) {
          return h("div", { class: "account-block" }, h("h3", {}, ...addressed(account.name)), switchRow, description(accountSwitch.offNote, null, "indent"));
        }
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
        // Every account has such a button: the name says whose it is.
        named(add, account.name);
        select.addEventListener("input", () => {
          add.disabled = select.value === "";
          // The menus of one column share one width: a longer name is shortened, and the tooltip has all of it.
          select.title = select.value === "" ? "" : (select.selectedOptions[0]?.textContent ?? "");
        });
        const rows = keys.map((key) => {
          const path = key.slice(prefix.length);
          const folder = chosen.find((candidate) => candidate.path === path);
          if (folder === undefined || options.removed.has(key)) {
            // Undo stands where the remove button was, and takes the focus that button had.
            const quiet = h("li", { class: "removed-row" }, ...options.removed.content(key, `remove:${path}`));
            quiet.dataset.key = key;
            return quiet;
          }
          const removable = options.removable(account, folder);
          const row = h(
            "li",
            {},
            h("span", { class: "name", text: folder.name, title: folder.path }),
            removable ? null : h("span", { class: "note", text: options.fixedNote }),
          );
          row.dataset.key = key;
          if (removable) {
            const remove = removeButton(t("removeNamedIn", folder.name, account.name), () => options.onRemove(account, folder, row));
            remove.dataset.focus = `remove:${folder.path}`;
            row.appendChild(remove);
          }
          return row;
        });
        return h(
          "div",
          { class: "account-block" },
          h("h3", {}, ...addressed(account.name)),
          switchRow,
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
              : // As high as the row with the menu that stands here otherwise, so that the lists below keep their place when a folder is removed.
                description(t("noFolderToAdd"), null, "add-line")
            : h("div", { class: "row" }, h("label", { for: selectId, class: "visually-hidden", text: t("folderToAdd", account.name) }), select, add),
        );
      },
    };
  });
}
