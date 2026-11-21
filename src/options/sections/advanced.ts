// Advanced: the public mail providers, and the forwarding mailboxes with the labels
// their forwarded header blocks use.

import { normalizeAddress, normalizeDomain } from "../../core/address";
import type { SettingsPatch } from "../../core/edit";
import { BUNDLED_PUBLIC_DOMAINS } from "../../data/publicDomains";
import { stringsLocale, t, tCode } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { address, button, byId, description, fieldError, guard, h, iconButton, inlineStatus, learnMore, reconcile, replace } from "../dom";
import type { Keyed } from "../dom";
import { mayRedraw, sameLabels } from "../fields";
import type { Model } from "../model";
import type { Section } from "../section";

const BUNDLED = new Set(BUNDLED_PUBLIC_DOMAINS);

/** Applies a change. Resolves to the items the background refused as not valid. */
async function update(patch: SettingsPatch): Promise<string[]> {
  return (await send("updateSettings", { patch })).invalid;
}

/** The rows of a list box: one per item with a remove button, or one line saying that there is none. */
function listRows(items: readonly string[], onRemove: (item: string) => void): Keyed[] {
  if (items.length === 0) {
    return [{ key: "empty", signature: "", build: () => h("li", { class: "empty", text: t("noneYet") }) }];
  }
  return items.map((item) => ({
    key: item,
    signature: "",
    build: () => {
      const remove = iconButton("close", t("removeNamed", item), () => onRemove(item), "quiet");
      remove.dataset.focus = "remove";
      return h("li", {}, h("span", { class: "name" }, address(item)), remove);
    },
  }));
}

export function advancedSection(): Section {
  const root = byId("advanced");
  let model: Model | null = null;

  // Public mail providers.
  const domain = h("input", { type: "text", id: "public-domain", placeholder: "example.com", oninput: () => describe(), attrs: { spellcheck: "false", autocomplete: "off" } });
  const domainError = fieldError(domain, "public-domain-error");
  const verdict = h("p", { class: "verdict", attrs: { role: "status" } });
  const makePublic = button(t("publicMakePublic"), () => change(true));
  const makeCustom = button(t("publicMakeCustom"), () => change(false));
  const added = h("ul", { class: "listbox", attrs: { "aria-labelledby": "public-added-title" } });
  const removed = h("ul", { class: "listbox", attrs: { "aria-labelledby": "public-removed-title" } });

  function current(): { domain: string | null; isPublic: boolean } {
    const value = normalizeDomain(domain.value);
    const settings = model?.settings;
    if (value === null || settings === null || settings === undefined) {
      return { domain: null, isPublic: false };
    }
    const isPublic = (BUNDLED.has(value) || settings.publicDomainsAdded.includes(value)) && !settings.publicDomainsRemoved.includes(value);
    return { domain: value, isPublic };
  }

  function describe(): void {
    const typed = domain.value.trim();
    const state = current();
    domainError.set(null);
    verdict.textContent = typed === "" || state.domain === null ? "" : state.isPublic ? t("publicIsPublic", state.domain) : t("publicIsCustom", state.domain);
    makePublic.disabled = state.domain === null || state.isPublic;
    makeCustom.disabled = state.domain === null || !state.isPublic;
  }

  function change(toPublic: boolean): void {
    const state = current();
    const settings = model?.settings;
    if (state.domain === null || settings === null || settings === undefined) {
      domainError.set(t("publicInvalid"));
      domain.focus();
      return;
    }
    const value = state.domain;
    void guard(
      async () => {
        if (toPublic) {
          await update({
            publicDomainsRemoved: settings.publicDomainsRemoved.filter((item) => item !== value),
            ...(BUNDLED.has(value) ? {} : { publicDomainsAdded: [...settings.publicDomainsAdded, value] }),
          });
        } else {
          await update({
            publicDomainsAdded: settings.publicDomainsAdded.filter((item) => item !== value),
            ...(BUNDLED.has(value) ? { publicDomainsRemoved: [...settings.publicDomainsRemoved, value] } : {}),
          });
        }
        // The button that was pressed is now unavailable: the keyboard goes back to the field.
        domain.focus();
      },
      (message) => domainError.set(message),
    );
  }

  // Forwarding mailboxes.
  const mailbox = h("input", { type: "email", id: "forward-mailbox", placeholder: "office@example.com", oninput: () => mailboxError.set(null), attrs: { spellcheck: "false", autocomplete: "off" } });
  const mailboxError = fieldError(mailbox, "forward-mailbox-error");
  const mailboxes = h("ul", { class: "listbox", attrs: { "aria-label": t("forwardingTitle") } });
  const labels = h("input", { type: "text", id: "forward-labels", oninput: () => drawLabelsState(), attrs: { spellcheck: "false", autocomplete: "off" } });
  const labelsError = fieldError(labels, "forward-labels-error");
  const labelsStatus = inlineStatus();
  /** What the page put into the labels field last. Anything else in it is an edit. */
  let labelsShown: string | null = null;
  let labelsStored = "";
  const saveLabels = button(t("save"), () =>
    void guard(
      async () => {
        const invalid = await update({ forwardLabels: labels.value.split(",") });
        labelsError.set(invalid.length > 0 ? t("invalidItems", invalid.join(", ")) : null);
        labelsStatus.flash(t("saved"));
        saveLabels.disabled = true;
      },
      (message) => labelsError.set(message),
    ),
  );

  function labelsDirty(): boolean {
    return !sameLabels(labels.value, labelsStored);
  }

  function drawLabelsState(): void {
    const dirty = labelsDirty();
    saveLabels.disabled = !dirty;
    if (dirty) {
      labelsStatus.set(t("unsavedChanges"));
    } else if (labelsStatus.element.textContent === t("unsavedChanges")) {
      labelsStatus.clear();
    }
  }

  const addMailbox = (): void => {
    const settings = model?.settings;
    if (settings === null || settings === undefined) {
      return;
    }
    const value = normalizeAddress(mailbox.value);
    if (value === null) {
      mailboxError.set(tCode("invalid", "address-invalid"));
      mailbox.focus();
      return;
    }
    void guard(
      async () => {
        await update({ forwardingMailboxes: [...settings.forwardingMailboxes, value] });
        mailbox.value = "";
        mailboxError.set(null);
        mailbox.focus();
      },
      (message) => mailboxError.set(message),
    );
  };

  replace(
    root,
    h("h1", { text: t("catAdvanced"), tabIndex: -1 }),
    h("h2", { text: t("publicTitle") }),
    description(t("publicHint"), learnMore(t("publicTitle"), t("publicMore", BUNDLED.size.toLocaleString(stringsLocale())))),
    h("div", { class: "row" }, h("label", { for: "public-domain", text: t("publicDomainLabel") }), domain, makePublic, makeCustom),
    domainError.element,
    verdict,
    h("h3", { text: t("publicAddedTitle"), id: "public-added-title" }),
    added,
    h("h3", { text: t("publicRemovedTitle"), id: "public-removed-title" }),
    removed,
    h("hr", {}),
    h("h2", { text: t("forwardingTitle") }),
    description(t("forwardingHint"), learnMore(t("forwardingTitle"), t("forwardingHowTo"), t("forwardingMore"))),
    h(
      "form",
      {
        class: "row",
        attrs: { novalidate: "" },
        onsubmit: (event) => {
          event.preventDefault();
          addMailbox();
        },
      },
      h("label", { for: "forward-mailbox", text: t("forwardingMailboxLabel") }),
      mailbox,
      h("button", { type: "submit", text: t("add") }),
    ),
    mailboxError.element,
    mailboxes,
    h("h3", { text: t("forwardLabelsTitle") }),
    description(t("forwardLabelsHint"), learnMore(t("forwardLabelsTitle"), t("forwardLabelsMore"))),
    h("div", { class: "row" }, h("label", { for: "forward-labels", class: "visually-hidden", text: t("forwardLabelsTitle") }), labels, saveLabels, labelsStatus.element),
    labelsError.element,
  );
  describe();

  return {
    render(next: Model) {
      model = next;
      const settings = next.settings;
      if (settings === null) {
        return;
      }
      reconcile(
        added,
        listRows(settings.publicDomainsAdded, (item) => void guard(() => update({ publicDomainsAdded: settings.publicDomainsAdded.filter((other) => other !== item) }))),
      );
      reconcile(
        removed,
        listRows(settings.publicDomainsRemoved, (item) => void guard(() => update({ publicDomainsRemoved: settings.publicDomainsRemoved.filter((other) => other !== item) }))),
      );
      reconcile(
        mailboxes,
        listRows(settings.forwardingMailboxes, (item) => void guard(() => update({ forwardingMailboxes: settings.forwardingMailboxes.filter((other) => other !== item) }))),
      );
      describe();
      const stored = settings.forwardLabels.join(", ");
      labelsStored = stored;
      if (mayRedraw({ value: labels.value, focused: document.activeElement === labels }, labelsShown, stored, sameLabels)) {
        labels.value = stored;
        labelsShown = stored;
      }
      drawLabelsState();
    },
    unsaved() {
      return labelsDirty();
    },
  };
}
