// Shortcuts: the four commands with their keys, the Smart switch, the other ways to
// block and trust, and the bare keys of the optional companion add-on.

import { COMMANDS } from "../../core/commandNames";
import type { CommandName } from "../../core/commandNames";
import { t } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { button, byId, checkRow, description, guard, h, learnMore, replace } from "../dom";
import { formatShortcut } from "../format";
import type { Model } from "../model";
import type { Section, Shell } from "../section";
import { loadShortcutKeys } from "../shortcutKeys";

const COMMAND_LABELS: Record<CommandName, string> = {
  "block-address": "cmdBlockAddress",
  "block-domain": "cmdBlockDomain",
  "trust-address": "cmdTrustAddress",
  "trust-domain": "cmdTrustDomain",
};

export function shortcutsSection(shell: Shell): Section {
  const root = byId("shortcuts");
  const bindings = h("tbody");
  const bareKeys = h("p");
  const smart = checkRow("smart-switch", t("smartLabel"), (checked) => void guard(() => send("updateSettings", { patch: { smart: checked } })));
  const companionFile = `block-spam-keys-${browser.runtime.getManifest().version}.xpi`;

  async function drawBindings(): Promise<void> {
    const { mac, keys } = await loadShortcutKeys();
    replace(
      bindings,
      ...COMMANDS.map((command) => {
        const key = keys.get(command);
        return h(
          "tr",
          {},
          h("th", { text: t(COMMAND_LABELS[command]), attrs: { scope: "row" } }),
          h("td", {}, key === undefined ? h("span", { class: "description", text: t("shortcutNone") }) : h("kbd", { text: key })),
        );
      }),
    );
    bareKeys.textContent = t("bareKeysInstall", ["B", "Shift+B", "W", "Shift+W"].map((key) => formatShortcut(key, mac)).join(", "));
  }

  replace(
    root,
    h("h1", { text: t("catShortcuts"), tabIndex: -1 }),
    description(t("shortcutsHint"), learnMore(t("catShortcuts"), t("shortcutsMore"))),
    h(
      "table",
      { class: "keys" },
      h("thead", {}, h("tr", {}, h("th", { text: t("colCommand"), attrs: { scope: "col" } }), h("th", { text: t("colShortcut"), attrs: { scope: "col" } }))),
      bindings,
    ),
    h("div", { class: "row" }, button(t("shortcutsChange"), () => void guard(() => browser.commands.openShortcutSettings()))),
    description(t("shortcutsRebindHint")),
    h("h2", { text: t("smartTitle") }),
    smart.row,
    description(t("smartHint"), null, "indent"),
    h("h2", { text: t("otherWaysTitle") }),
    h(
      "ul",
      { class: "ways" },
      h("li", {}, h("strong", { text: t("otherWaysPopupName") }), " ", t("otherWaysPopup")),
      h("li", {}, h("strong", { text: t("otherWaysMenuName") }), " ", t("otherWaysMenu")),
      h(
        "li",
        {},
        h("strong", { text: t("otherWaysLogName") }),
        " ",
        t("otherWaysLog"),
        " ",
        h("a", {
          href: "#log",
          text: t("otherWaysLogLink"),
          onclick: (event) => {
            event.preventDefault();
            shell.go("log");
          },
        }),
      ),
    ),
    h("h2", { text: t("bareKeysTitle") }),
    description(t("bareKeysHint")),
    h("p", {}, t("bareKeysFile"), " ", h("code", { text: companionFile })),
    bareKeys,
  );
  browser.commands.onChanged.addListener(() => void guard(drawBindings));
  void guard(drawBindings);

  return {
    render(model: Model) {
      if (model.settings !== null) {
        smart.input.checked = model.settings.smart;
      }
      // The bindings can be changed in Thunderbird while this page is open.
      void guard(drawBindings);
    },
  };
}
