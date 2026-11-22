// Advanced: whether the entries the add-on makes by itself are shared between accounts,
// the public mail providers, and the forwarding mailboxes with the labels their forwarded
// header blocks use.

import { normalizeAddress, normalizeDomain } from "../../core/address";
import type { SettingsPatch } from "../../core/edit";
import type { Settings } from "../../core/types";
import { BUNDLED_PUBLIC_DOMAINS } from "../../data/publicDomains";
import { stringsLocale, t, tCode } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { address, addressed, button, byId, description, fieldError, guard, h, inlineStatus, learnMore, named, option, paneLink, reconcile, removeButton, removedRows, replace, tNodes } from "../dom";
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
  /** Draws the items. `remover` says how an item is taken off the stored list, and how Undo puts it back. */
  draw(items: readonly string[], remover: (item: string) => { remove: () => Promise<unknown>; undo: () => Promise<unknown> }): void;
  /** The rows that were removed leave their places. */
  clear(): void;
}

/**
 * `labelledBy` names the heading of the list. A removed item stays in its place as a quiet row with Undo, so that
 * nothing moves under the pointer: `redraw` draws the list again when such a row comes or goes.
 */
function plainList(label: { labelledBy: string } | { label: string }, redraw: () => void): PlainList {
  const list = h("ul", {
    class: "plain-list",
    attrs: "labelledBy" in label ? { "aria-labelledby": label.labelledBy } : { "aria-label": label.label },
  });
  const empty = description(t("noneYet"));
  const gone = removedRows(redraw);
  return {
    element: h("div", {}, empty, list),
    draw(items, remover) {
      const keys = gone.order(items);
      list.hidden = keys.length === 0;
      empty.hidden = keys.length > 0;
      reconcile(
        list,
        keys.map(
          (item): Keyed =>
            gone.has(item)
              ? { key: item, signature: `removed|${gone.signature(item)}`, build: () => h("li", { class: "removed-row" }, ...gone.content(item)) }
              : {
                  key: item,
                  signature: "",
                  build: () => {
                    const row = h("li", {}, h("span", { class: "name" }, address(item)));
                    row.appendChild(
                      removeButton(t("removeNamed", item), () => {
                        const { remove, undo } = remover(item);
                        gone.remove(row, t("listsRemoved", item), remove, undo, t("listsRestored", item));
                      }),
                    );
                    return row;
                  },
                },
        ),
      );
    },
    clear: () => gone.clear(),
  };
}

export function advancedSection(): Section {
  const root = byId("advanced");
  let model: Model | null = null;

  // Sharing between accounts: whether the entries the add-on makes by itself (by learning, by an AI score, by blocking
  // or trusting) are shared by all accounts. A setting made once, so it lives here and not among the entries. It means
  // something only with two or more mail accounts, and is not shown with fewer.
  const lead = h("p", { class: "lead", text: t("advancedLead") });
  const newScope = h(
    "select",
    {
      id: "new-scope",
      onchange: () => void guard(() => update({ newEntryScope: newScope.value as Settings["newEntryScope"] })),
    },
    option("shared", t("scopeShared")),
    option("account", t("scopePerAccount")),
  );
  const sharing = h(
    "div",
    { class: "group", hidden: true },
    h("h2", { text: t("newEntriesTitle") }),
    h("div", { class: "row" }, h("label", { for: "new-scope", text: t("newEntriesLabel") }), newScope),
    // The form the sentence names is on another pane: its name leads there.
    h("div", { class: "description" }, ...tNodes("newEntriesHint", paneLink("lists", t("catLists"), () => {
      location.hash = "lists";
    }))),
  );

  // Public mail providers.
  // The label next to it says "Domain:". The name says of what.
  const domain = h("input", { type: "text", id: "public-domain", placeholder: "example.com", oninput: () => describe(), attrs: { spellcheck: "false", autocomplete: "off", "aria-label": t("publicDomainName") } });
  const domainError = fieldError(domain, "public-domain-error");
  const verdict = h("p", { class: "verdict", attrs: { role: "status" } });
  const makePublic = button(t("publicMakePublic"), () => change(true));
  const makeCustom = button(t("publicMakeCustom"), () => change(false));
  /** Draws the lists again when a removed row comes or goes. */
  const redraw = (): void => {
    if (model !== null) {
      section.render(model);
    }
  };
  const added = plainList({ labelledBy: "public-added-title" }, redraw);
  const removed = plainList({ labelledBy: "public-removed-title" }, redraw);

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
    // The name of each button says which domain it acts on, once the field holds one.
    named(makePublic, state.domain ?? "");
    named(makeCustom, state.domain ?? "");
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
    // The next action in these lists: the rows that were removed leave their places.
    added.clear();
    removed.clear();
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
  const addMailboxButton = h("button", { type: "submit", text: t("add"), disabled: true, attrs: { "aria-label": t("forwardingAddOne") } });
  const mailboxError = fieldError(mailbox, "forward-mailbox-error");
  const mailboxes = plainList({ label: t("forwardingTitle") }, redraw);
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

  named(saveLabels, t("forwardLabelsTitle"));

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
    // The next action in this list: the rows that were removed leave their places.
    mailboxes.clear();
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
    lead,
    sharing,
    h("h2", { text: t("publicTitle") }),
    description(t("publicHint"), learnMore(t("publicTitle"), t("publicMore", BUNDLED.size.toLocaleString(stringsLocale())))),
    h("div", { class: "row" }, h("label", { for: "public-domain", text: t("publicDomainLabel") }), domain, makePublic, makeCustom),
    domainError.element,
    verdict,
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
    mailboxes.element,
    h("h3", { text: t("forwardLabelsTitle") }),
    labelsUnused,
    description(t("forwardLabelsHint"), learnMore(t("forwardLabelsTitle"), t("forwardLabelsMore"))),
    h("div", { class: "row" }, h("label", { for: "forward-labels", class: "visually-hidden", text: t("forwardLabelsTitle") }), labels, saveLabels, labelsStatus.element),
    labelsError.element,
  );
  describe();

  const section: Section = {
    render(next: Model) {
      model = next;
      const settings = next.settings;
      if (settings === null) {
        return;
      }
      // With fewer than two mail accounts sharing could change nothing: the group is not shown, and the lead does not name it.
      const several = next.accounts.length > 1;
      sharing.hidden = !several;
      const leadText = t(several ? "advancedLeadSharing" : "advancedLead");
      if (lead.textContent !== leadText) {
        lead.textContent = leadText;
      }
      newScope.value = settings.newEntryScope;
      // A removed item stays in its place as a quiet row with Undo. Both apply to the list as it is then, not as it
      // was when the row was drawn, and Undo puts the item back in the place it had.
      const remover = (name: "publicDomainsAdded" | "publicDomainsRemoved" | "forwardingMailboxes") => (item: string) => {
        const index = model?.settings?.[name].indexOf(item) ?? -1;
        return {
          remove: async () => {
            const current = model?.settings;
            if (current !== null && current !== undefined) {
              await update({ [name]: current[name].filter((other) => other !== item) });
            }
          },
          undo: async () => {
            const current = model?.settings;
            if (current !== null && current !== undefined) {
              const rest = current[name].filter((other) => other !== item);
              const at = index < 0 ? rest.length : Math.min(index, rest.length);
              await update({ [name]: [...rest.slice(0, at), item, ...rest.slice(at)] });
            }
          },
        };
      };
      added.draw(settings.publicDomainsAdded, remover("publicDomainsAdded"));
      removed.draw(settings.publicDomainsRemoved, remover("publicDomainsRemoved"));
      mailboxes.draw(settings.forwardingMailboxes, remover("forwardingMailboxes"));
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
      added.clear();
      removed.clear();
      mailboxes.clear();
    },
  };
  return section;
}
