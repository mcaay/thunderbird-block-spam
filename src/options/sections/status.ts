// Status and setup: the protection and observation switches, the setup checklist and warnings.

import { whiteListIsOnlyIdentities, entriesFromArray } from "../../core/lists";
import { t } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { button, byId, dialog, download, guard, h, replace } from "../dom";
import { monitoredFolders } from "../model";
import type { Model } from "../model";
import type { Section } from "../section";

export function statusSection(): Section {
  const root = byId("status");
  const fatalBox = h("div", { class: "fatal" });
  const body = h("div");
  const protection = h("input", {
    type: "checkbox",
    id: "protection-switch",
    onchange: () => void guard(() => send("setProtection", { on: protection.checked })),
  });
  const protectionState = h("span", { class: "state" });
  const observation = h("input", {
    type: "checkbox",
    id: "observation-switch",
    onchange: () => void guard(() => send("updateSettings", { patch: { observation: observation.checked } })),
  });
  const checklist = h("ol", { class: "checklist" });
  const warnings = h("div", { class: "warnings" });

  replace(
    body,
    h(
      "div",
      { class: "switch-row" },
      protection,
      h("label", { for: "protection-switch", text: t("protectionLabel") }),
      protectionState,
    ),
    h("p", { class: "hint", text: t("protectionHint") }),
    h("div", { class: "switch-row" }, observation, h("label", { for: "observation-switch", text: t("observationLabel") })),
    h("p", { class: "hint", text: t("observationHint") }),
    h("h3", { text: t("checklistTitle") }),
    checklist,
    warnings,
  );
  replace(root, h("h2", { text: t("sectionStatus") }), fatalBox, body);

  function renderFatal(message: string): void {
    replace(
      fatalBox,
      h("h3", { text: t("fatalTitle") }),
      h("p", { text: t("fatalText") }),
      h("pre", { text: message }),
      h(
        "div",
        { class: "actions" },
        button(t("fatalDownload"), () =>
          void guard(async () => {
            // Read-only: the page reads storage but never writes it.
            const raw = await browser.storage.local.get(null);
            download("block-spam-raw-data.json", JSON.stringify(raw, null, 2));
          }),
        ),
        button(
          t("fatalReset"),
          () =>
            void dialog({
              title: t("fatalResetTitle"),
              body: [t("fatalResetText")],
              confirmLabel: t("fatalReset"),
              danger: true,
              onConfirm: async () => {
                await send("resetData", {});
              },
            }),
          "danger",
        ),
      ),
      h("p", { class: "hint", text: t("fatalDownloadHint") }),
    );
  }

  return {
    render(model: Model) {
      const { settings } = model;
      if (model.status.fatal !== null || settings === null) {
        renderFatal(model.status.fatal ?? t("errorNotReady"));
        fatalBox.hidden = false;
        body.hidden = true;
        return;
      }
      fatalBox.hidden = true;
      body.hidden = false;

      protection.checked = settings.protection;
      protectionState.textContent = settings.protection
        ? settings.observation
          ? t("protectionObserving")
          : t("protectionOn")
        : t("protectionOff");
      protectionState.className = `state ${settings.protection ? "on" : "off"}`;
      observation.checked = settings.observation;

      const scanned = model.entries.some((entry) => entry.list === "white" && entry.source !== "identity");
      const steps: [boolean, string, string][] = [
        [scanned, t("checklistScan"), "#learning"],
        [model.accessPoints.length > 0, t("checklistAi"), "#ai"],
        [settings.protection, t("checklistProtect"), "#status"],
      ];
      replace(
        checklist,
        ...steps.map(([done, label, link]) =>
          h("li", { class: done ? "done" : "" }, h("span", { class: "mark", text: done ? "✓" : "" }), h("a", { href: link, text: label })),
        ),
      );

      const items: string[] = [];
      if (model.accessPoints.some((point) => point.enabled) && whiteListIsOnlyIdentities(entriesFromArray(model.entries))) {
        items.push(t("warnAiBeforeScan"));
      }
      const noJunk = model.accounts.filter((account) => monitoredFolders(account, settings).length > 0 && !account.hasJunk);
      if (noJunk.length > 0) {
        items.push(t("warnNoJunk", noJunk.map((account) => account.name).join(", ")));
      }
      const attention = model.accessPoints.filter((point) => point.needsAttention);
      if (attention.length > 0) {
        items.push(t("warnNeedsAttention", attention.map((point) => point.name).join(", ")));
      }
      if (settings.noVerdictAction === "screening") {
        const missing = model.accounts.filter(
          (account) =>
            monitoredFolders(account, settings).length > 0 &&
            !settings.screeningFolders.some((folder) => folder.accountId === account.id),
        );
        if (missing.length > 0) {
          items.push(t("warnNoScreening", missing.map((account) => account.name).join(", ")));
        }
      }
      replace(warnings, ...items.map((text) => h("p", { class: "warning", text })));
    },
  };
}
