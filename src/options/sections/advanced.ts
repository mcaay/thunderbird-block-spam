// Advanced: the public mail providers, and the forwarding mailboxes with the labels
// their forwarded header blocks use.

import { normalizeAddress, normalizeDomain } from "../../core/address";
import type { SettingsPatch } from "../../core/edit";
import { BUNDLED_PUBLIC_DOMAINS } from "../../data/publicDomains";
import { stringsLocale, t, tCode } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { address, addressed, button, byId, description, fieldError, focusNeighbor, guard, h, inlineStatus, learnMore, notice, reconcile, removeButton, replace } from "../dom";
import { icon } from "../icons";
import type { Keyed } from "../dom";
import { mayRedraw, sameLabels } from "../fields";
import type { Model } from "../model";
import type { Section } from "../section";

const BUNDLED = new Set(BUNDLED_PUBLIC_DOMAINS);

/** Applies a change. Resolves to the items the background refused as not valid. */
async function update(patch: SettingsPatch): Promise<string[]> {
  return (await send("updateSettings", { patch })).invalid;
}

/** A list of domains or addresses: plain rows with a remove button each, or one line saying that there is none. */
interface PlainList {
  element: HTMLElement;
  /** Draws the items. `onRemove` gets the item whose remove button was pressed. */
  draw(items: readonly string[], onRemove: (item: string) => void): void;
}

/** `labelledBy` names the heading of the list, `fallback` takes the focus when the last row is removed. */
function plainList(label: { labelledBy: string } | { label: string }, fallback: HTMLElement): PlainList {
  const list = h("ul", {
    class: "plain-list",
    attrs: "labelledBy" in label ? { "aria-labelledby": label.labelledBy } : { "aria-label": label.label },
  });
  const empty = description(t("noneYet"));
  return {
    element: h("div", {}, empty, list),
    draw(items, onRemove) {
      list.hidden = items.length === 0;
      empty.hidden = items.length > 0;
      reconcile(
        list,
        items.map(
          (item): Keyed => ({
            key: item,
            signature: "",
            build: () => {
              const row = h("li", {}, h("span", { class: "name" }, address(item)));
              row.appendChild(
                removeButton(t("removeNamed", item), () => {
                  // The row is about to go: the keyboard goes on with the row next to it, or with the field for adding.
                  focusNeighbor(row, fallback);
                  onRemove(item);
                }),
              );
              return row;
            },
          }),
        ),
      );
    },
  };
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
  const added = plainList({ labelledBy: "public-added-title" }, domain);
  const removed = plainList({ labelledBy: "public-removed-title" }, domain);
  /** What the last removal from the lists of this group did, with Undo. */
  const domainNotice = notice();

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
    // Both buttons are unavailable until the field holds a domain: the line under it says what is expected.
    const said = typed === "" ? "" : state.domain === null ? t("publicInvalid") : state.isPublic ? t("publicIsPublic", state.domain) : t("publicIsCustom", state.domain);
    if (verdict.textContent !== said) {
      // The domain in the sentence breaks like a domain.
      replace(verdict, ...addressed(said));
    }
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
    domainNotice.clear();
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
  const mailbox = h("input", {
    type: "email",
    id: "forward-mailbox",
    placeholder: "office@example.com",
    oninput: () => {
      mailboxError.set(null);
      // Nothing can be added before something is typed: the button says so by being unavailable.
      addMailboxButton.disabled = mailbox.value.trim() === "";
    },
    attrs: { spellcheck: "false", autocomplete: "off" },
  });
  const addMailboxButton = h("button", { type: "submit", text: t("add"), disabled: true });
  const mailboxError = fieldError(mailbox, "forward-mailbox-error");
  const mailboxes = plainList({ label: t("forwardingTitle") }, mailbox);
  /** What the last removal of a mailbox did, with Undo. */
  const mailboxNotice = notice();
  const labels = h("input", { type: "text", id: "forward-labels", oninput: () => drawLabelsState(), attrs: { spellcheck: "false", autocomplete: "off" } });
  const labelsError = fieldError(labels, "forward-labels-error");
  const labelsStatus = inlineStatus();
  /** Said while no forwarding mailbox is listed: the labels are read only in mail that such a mailbox forwarded. */
  const labelsUnused = h(
    "div",
    { class: "option-note plain", id: "forward-labels-unused", hidden: true },
    icon("info"),
    h("span", { text: t("forwardLabelsUnused") }),
    button(t("forwardingAddOne"), () => {
      mailbox.scrollIntoView({ block: "center" });
      mailbox.focus();
    }, "link"),
  );
  /** What the page put into the labels field last. Anything else in it is an edit. */
  let labelsShown: string | null = null;
  let labelsStored = "";
  const saveLabels = button(t("save"), () =>
    void guard(
      async () => {
        const invalid = await update({ forwardLabels: labels.value.split(",") });
        labelsError.set(invalid.length > 0 ? t("invalidItems", invalid.join(", ")) : null);
        labelsStored = labels.value;
        // Save is unavailable again: the keyboard goes back to the field.
        labels.focus();
        drawLabelsState();
        labelsStatus.flash(t("saved"));
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
    // Save stands out only while there is something to save.
    saveLabels.classList.toggle("primary", dirty);
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
    mailboxNotice.clear();
    void guard(
      async () => {
        await update({ forwardingMailboxes: [...settings.forwardingMailboxes, value] });
        mailbox.value = "";
        addMailboxButton.disabled = true;
        mailboxError.set(null);
        mailbox.focus();
      },
      (message) => mailboxError.set(message),
    );
  };

  replace(
    root,
    h("h1", { text: t("catAdvanced"), tabIndex: -1 }),
    h("p", { class: "lead", text: t("advancedLead") }),
    h("h2", { text: t("publicTitle") }),
    description(t("publicHint"), learnMore(t("publicTitle"), t("publicMore", BUNDLED.size.toLocaleString(stringsLocale())))),
    h("div", { class: "row" }, h("label", { for: "public-domain", text: t("publicDomainLabel") }), domain, makePublic, makeCustom),
    domainError.element,
    verdict,
    domainNotice.element,
    h("h3", { text: t("publicAddedTitle"), id: "public-added-title" }),
    added.element,
    h("h3", { text: t("publicRemovedTitle"), id: "public-removed-title" }),
    removed.element,
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
      addMailboxButton,
    ),
    mailboxError.element,
    mailboxNotice.element,
    mailboxes.element,
    h("h3", { text: t("forwardLabelsTitle") }),
    labelsUnused,
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
      // Removing gives a confirmation with Undo. Undo applies to the list as it is then, not as it was.
      const removable = (name: "publicDomainsAdded" | "publicDomainsRemoved" | "forwardingMailboxes", where: typeof domainNotice) => (item: string) =>
        void guard(async () => {
          await update({ [name]: settings[name].filter((other) => other !== item) });
          where.show(
            t("listsRemoved", item),
            async () => {
              const current = model?.settings;
              if (current !== null && current !== undefined) {
                await update({ [name]: [...current[name].filter((other) => other !== item), item] });
              }
            },
            t("listsRestored", item),
          );
        });
      added.draw(settings.publicDomainsAdded, removable("publicDomainsAdded", domainNotice));
      removed.draw(settings.publicDomainsRemoved, removable("publicDomainsRemoved", domainNotice));
      mailboxes.draw(settings.forwardingMailboxes, removable("forwardingMailboxes", mailboxNotice));
      labelsUnused.hidden = settings.forwardingMailboxes.length > 0;
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
      // The labels, and the address of a mailbox that was typed and not added yet, are lost with the page. The domain
      // field is a question the page answers while it is typed: nothing of it is waiting to be saved.
      return labelsDirty() || mailbox.value.trim() !== "";
    },
    leave() {
      domainNotice.clear();
      mailboxNotice.clear();
    },
  };
}
