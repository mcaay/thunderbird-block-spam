// Public domains and forwarding mailboxes: two editable lists with a short explanation.

import { normalizeDomain } from "../../core/address";
import type { SettingsPatch } from "../../core/edit";
import { BUNDLED_PUBLIC_DOMAINS } from "../../data/publicDomains";
import { t } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { button, byId, guard, h, replace, toast } from "../dom";
import type { Model } from "../model";
import type { Section } from "../section";

const BUNDLED = new Set(BUNDLED_PUBLIC_DOMAINS);

async function update(patch: SettingsPatch): Promise<void> {
  const { invalid } = await send("updateSettings", { patch });
  if (invalid.length > 0) {
    toast(t("invalidItems", invalid.join(", ")), "error");
  }
}

function chips(items: readonly string[], onRemove: (item: string) => void, empty: string): HTMLElement {
  if (items.length === 0) {
    return h("p", { class: "hint", text: empty });
  }
  return h(
    "ul",
    { class: "chips" },
    ...items.map((item) => h("li", {}, h("span", { text: item }), button("×", () => onRemove(item), "chip-remove"))),
  );
}

export function publicDomainsSection(): Section {
  const root = byId("public");
  let model: Model | null = null;
  const input = h("input", { type: "text", placeholder: "example.com", oninput: () => describe() });
  const verdict = h("p", { class: "hint" });
  const added = h("div");
  const removed = h("div");

  function current(): { domain: string | null; isPublic: boolean } {
    const domain = normalizeDomain(input.value);
    const settings = model?.settings;
    if (domain === null || settings === null || settings === undefined) {
      return { domain: null, isPublic: false };
    }
    const isPublic = (BUNDLED.has(domain) || settings.publicDomainsAdded.includes(domain)) && !settings.publicDomainsRemoved.includes(domain);
    return { domain, isPublic };
  }

  function describe(): void {
    const { domain, isPublic } = current();
    verdict.textContent =
      input.value.trim() === ""
        ? t("publicCount", BUNDLED.size)
        : domain === null
          ? t("publicInvalid")
          : isPublic
            ? t("publicIsPublic", domain)
            : t("publicIsCustom", domain);
  }

  function change(makePublic: boolean): void {
    const { domain } = current();
    const settings = model?.settings;
    if (domain === null || settings === null || settings === undefined) {
      toast(t("publicInvalid"), "error");
      return;
    }
    void guard(async () => {
      if (makePublic) {
        await update({
          publicDomainsRemoved: settings.publicDomainsRemoved.filter((item) => item !== domain),
          ...(BUNDLED.has(domain) ? {} : { publicDomainsAdded: [...settings.publicDomainsAdded, domain] }),
        });
      } else {
        await update({
          publicDomainsAdded: settings.publicDomainsAdded.filter((item) => item !== domain),
          ...(BUNDLED.has(domain) ? { publicDomainsRemoved: [...settings.publicDomainsRemoved, domain] } : {}),
        });
      }
      input.value = "";
    });
  }

  replace(
    root,
    h("h2", { text: t("sectionPublic") }),
    h("p", { class: "hint", text: t("publicHint") }),
    h("div", { class: "row" }, input, button(t("publicMakePublic"), () => change(true)), button(t("publicMakeCustom"), () => change(false))),
    verdict,
    h("h3", { text: t("publicAddedTitle") }),
    added,
    h("h3", { text: t("publicRemovedTitle") }),
    removed,
  );

  return {
    render(next: Model) {
      model = next;
      const settings = next.settings;
      if (settings === null) {
        return;
      }
      replace(
        added,
        chips(
          settings.publicDomainsAdded,
          (domain) => void guard(() => update({ publicDomainsAdded: settings.publicDomainsAdded.filter((item) => item !== domain) })),
          t("noneYet"),
        ),
      );
      replace(
        removed,
        chips(
          settings.publicDomainsRemoved,
          (domain) => void guard(() => update({ publicDomainsRemoved: settings.publicDomainsRemoved.filter((item) => item !== domain) })),
          t("noneYet"),
        ),
      );
      describe();
    },
  };
}

export function forwardingSection(): Section {
  const root = byId("forwarding");
  let model: Model | null = null;
  const input = h("input", { type: "email", placeholder: "office@example.com" });
  const list = h("div");
  const labels = h("input", { type: "text" });
  let labelsSaved = "";

  const add = (): void => {
    const settings = model?.settings;
    if (settings === null || settings === undefined || input.value.trim() === "") {
      return;
    }
    void guard(async () => {
      await update({ forwardingMailboxes: [...settings.forwardingMailboxes, input.value] });
      input.value = "";
    });
  };

  replace(
    root,
    h("h2", { text: t("sectionForwarding") }),
    h("p", { class: "hint", text: t("forwardingHint") }),
    h("p", { class: "hint", text: t("forwardingHowTo") }),
    h(
      "form",
      {
        class: "row",
        onsubmit: (event) => {
          event.preventDefault();
          add();
        },
      },
      input,
      h("button", { type: "submit", text: t("add"), class: "primary" }),
    ),
    list,
    h("h3", { text: t("forwardLabelsTitle") }),
    h("p", { class: "hint", text: t("forwardLabelsHint") }),
    h(
      "div",
      { class: "row" },
      labels,
      button(t("save"), () =>
        void guard(async () => {
          await update({ forwardLabels: labels.value.split(",") });
          toast(t("saved"));
        }),
      ),
    ),
  );

  return {
    render(next: Model) {
      model = next;
      const settings = next.settings;
      if (settings === null) {
        return;
      }
      replace(
        list,
        chips(
          settings.forwardingMailboxes,
          (mailbox) => void guard(() => update({ forwardingMailboxes: settings.forwardingMailboxes.filter((item) => item !== mailbox) })),
          t("noneYet"),
        ),
      );
      const stored = settings.forwardLabels.join(", ");
      if (labels.value === labelsSaved || document.activeElement !== labels) {
        labels.value = stored;
      }
      labelsSaved = stored;
    },
  };
}
