// Block and trust: every way to block or trust a sender by hand. The four commands
// with their keys, the Smart switch, the toolbar button, the context menu and the log.

import { COMMANDS } from "../../core/commandNames";
import type { CommandName } from "../../core/commandNames";
import { t } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { button, byId, checkRow, description, guard, h, learnMore, replace, withMore } from "../dom";
import type { Model } from "../model";
import type { Section, Shell } from "../section";
import { loadShortcutKeys } from "../shortcutKeys";

const COMMAND_LABELS: Record<CommandName, string> = {
  "block-address": "cmdBlockAddress",
  "block-domain": "cmdBlockDomain",
  "trust-address": "cmdTrustAddress",
  "trust-domain": "cmdTrustDomain",
};

export function blockAndTrustSection(shell: Shell): Section {
  const root = byId("block-and-trust");
  const bindings = h("tbody");
  const smart = checkRow("smart-switch", t("smartLabel"), (checked) => void guard(() => send("updateSettings", { patch: { smart: checked } })));

  async function drawBindings(): Promise<void> {
    const { keys } = await loadShortcutKeys();
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
  }

  replace(
    root,
    h("h1", { text: t("catBlockAndTrust"), tabIndex: -1 }),
    h("p", { class: "lead" }, ...withMore(t("blockAndTrustLead"), learnMore(t("catBlockAndTrust"), t("shortcutsMore")))),
    h("h2", { text: t("shortcutsTitle") }),
    description(t("shortcutsHint")),
    h(
      "table",
      { class: "keys" },
      h("thead", {}, h("tr", {}, h("th", { text: t("colCommand"), attrs: { scope: "col" } }), h("th", { text: t("colShortcut"), attrs: { scope: "col" } }))),
      bindings,
    ),
    h("div", { class: "row" }, button(t("shortcutsChange"), () => void guard(() => browser.commands.openShortcutSettings()))),
    description(t("shortcutsRebindHint")),
    // Why no shortcut is a key on its own: the question comes up where the shortcuts are changed.
    description(t("bareKeysHint")),
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
