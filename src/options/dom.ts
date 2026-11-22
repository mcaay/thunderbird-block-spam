// DOM helpers shared by the settings page and the popup. Content is always set as
// text, never as HTML.

import { t, tCode } from "../tb/i18n";
import { RequestError } from "../tb/protocol";
import { addressPieces, breakableParts } from "./format";
import { icon } from "./icons";
import type { IconName } from "./icons";

export type Child = Node | string | null | undefined | false;

interface Props {
  class?: string;
  text?: string;
  title?: string;
  id?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  href?: string;
  for?: string;
  name?: string;
  min?: string;
  max?: string;
  step?: string;
  label?: string;
  rows?: number;
  checked?: boolean;
  disabled?: boolean;
  selected?: boolean;
  readOnly?: boolean;
  hidden?: boolean;
  open?: boolean;
  colSpan?: number;
  tabIndex?: number;
  /** Attributes without a property of their own: role, aria-*, data-*, scope. */
  attrs?: Record<string, string | undefined>;
  onclick?: (event: MouseEvent) => void;
  onchange?: (event: Event) => void;
  oninput?: (event: Event) => void;
  onkeydown?: (event: KeyboardEvent) => void;
  onsubmit?: (event: SubmitEvent) => void;
}

/** Creates an element. Strings among the children become text nodes. */
export function h<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[Tag] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined) {
      continue;
    }
    if (name === "class") {
      element.className = String(value);
    } else if (name === "text") {
      element.textContent = String(value);
    } else if (name === "for") {
      element.setAttribute("for", String(value));
    } else if (name === "attrs") {
      for (const [attribute, text] of Object.entries(value as Record<string, string | undefined>)) {
        if (text !== undefined) {
          element.setAttribute(attribute, text);
        }
      }
    } else if (name.startsWith("on") && typeof value === "function") {
      element.addEventListener(name.slice(2), value as EventListener);
    } else {
      (element as unknown as Record<string, unknown>)[name] = value;
    }
  }
  append(element, children);
  return element;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    parent.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

export function replace(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`missing element #${id}`);
  }
  return element as T;
}

export function option(value: string, label: string, selected = false): HTMLOptionElement {
  return h("option", { value, text: label, selected });
}

/** A button. Its action does not run while the button is marked unavailable. */
export function button(label: string, onclick: (event: MouseEvent) => void, cls = ""): HTMLButtonElement {
  const element = h("button", { type: "button", text: label, class: cls });
  element.addEventListener("click", (event) => {
    if (!isUnavailable(element)) {
      onclick(event);
    }
  });
  return element;
}

/**
 * Marks a button as unavailable without taking it out of the tab order. A disabled
 * button loses the keyboard focus, and the page is redrawn while buttons are busy.
 * Handlers check isUnavailable themselves.
 *
 * Where it is not obvious why the button cannot act, `reason` says what is missing: as
 * its tooltip, and as its description for a screen reader. The tooltip the button has
 * while it is available comes back with it.
 */
export function setUnavailable<T extends HTMLElement>(element: T, unavailable: boolean, reason?: string): T {
  if (unavailable) {
    element.setAttribute("aria-disabled", "true");
    if (reason !== undefined) {
      element.dataset.availableTitle ??= element.title;
      element.title = reason;
    }
    return element;
  }
  element.removeAttribute("aria-disabled");
  if (element.dataset.availableTitle !== undefined) {
    element.title = element.dataset.availableTitle;
    delete element.dataset.availableTitle;
    if (element.title === "") {
      element.removeAttribute("title");
    }
  }
  return element;
}

export function isUnavailable(element: Element): boolean {
  return element.getAttribute("aria-disabled") === "true";
}

/**
 * Runs the action of a button and keeps the button unavailable until it has ended, so
 * that a second click cannot start it twice. The button stays where the focus is.
 */
export async function whileBusy(element: HTMLElement, action: () => Promise<unknown>): Promise<void> {
  if (isUnavailable(element)) {
    return;
  }
  setUnavailable(element, true);
  // Busy, not merely unavailable: a filled button keeps its fill while its own action runs.
  element.setAttribute("aria-busy", "true");
  try {
    await action();
  } finally {
    element.removeAttribute("aria-busy");
    setUnavailable(element, false);
  }
}

/**
 * Gives a control the accessible name "label: object": the words that are seen on it, then what it acts on, so that
 * controls with the same label can be told apart by a screen reader. The name still starts with the visible text.
 */
export function named<T extends HTMLElement>(element: T, object: string, label = element.textContent ?? ""): T {
  element.setAttribute("aria-label", object === "" ? label : t("labelNamed", label, object));
  return element;
}

/** A button that shows only an icon. The label is its accessible name and its tooltip. */
export function iconButton(name: IconName, label: string, onclick: (event: MouseEvent) => void, cls = ""): HTMLButtonElement {
  const element = h("button", { type: "button", class: `icon ${cls}`.trim(), title: label, attrs: { "aria-label": label } }, icon(name));
  element.addEventListener("click", (event) => {
    if (!isUnavailable(element)) {
      onclick(event);
    }
  });
  return element;
}

/**
 * An address or a domain whose lines break only after the "@" and before a dot. Each part
 * between two such points is a box of its own that moves to the next line whole, and is
 * broken inside only when it alone is longer than the line. A hyphen stays with the
 * character after it, so that a line never ends with a hyphen that belongs to the address.
 * Nothing is added to the text: copied, it is the plain address.
 */
export function address(value: string, tail = ""): HTMLElement {
  const span = h("span", { class: "address" });
  let last: HTMLElement | null = null;
  breakableParts(value).forEach((part, index) => {
    if (index > 0) {
      span.appendChild(document.createElement("wbr"));
    }
    const box = h("span", { class: "part" });
    part.split(/(-+[^-]?)/).forEach((piece, position) => {
      if (piece !== "") {
        box.appendChild(position % 2 === 1 ? h("span", { class: "glue", text: piece }) : document.createTextNode(piece));
      }
    });
    span.appendChild(box);
    last = box;
  });
  // The punctuation of the sentence that follows the address stays with its last part: it never starts a line.
  if (tail !== "") {
    (last ?? span).appendChild(document.createTextNode(tail));
  }
  return span;
}

/**
 * A sentence, a label or a name that may hold addresses or domains: each of them is
 * built with address(), so that it breaks like one wherever it is shown.
 */
export function addressed(text: string): Child[] {
  // What closes the sentence or the bracket right after an address goes with it, so that it never starts a line.
  return addressPieces(text).map((piece) => (piece.address ? address(piece.text, piece.tail) : piece.text));
}

/** A link to a page outside Thunderbird. It opens in the default browser. */
export function externalLink(label: string, url: string): HTMLAnchorElement {
  return h("a", {
    href: url,
    text: label,
    onclick: (event) => {
      event.preventDefault();
      void browser.windows.openDefaultBrowser(url).catch((error: unknown) => reportError(errorText(error)));
    },
  });
}

/**
 * What to show for a failed action. Mistakes a user can make arrive with a code and
 * are said in the user's language. Anything else is a diagnostic of the background.
 */
export function errorText(error: unknown): string {
  if (error instanceof RequestError && error.code !== "") {
    const text = tCode("invalid", error.code);
    if (!text.startsWith("invalid_")) {
      return text;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Descriptions and disclosures.

/**
 * "Learn more": what does not fit into two lines of a description. The topic makes
 * the accessible name tell one disclosure from the next.
 */
export function learnMore(topic: string, ...paragraphs: Child[]): HTMLDetailsElement {
  return h(
    "details",
    { class: "more" },
    h("summary", { text: t("learnMore"), attrs: { "aria-label": t("learnMoreAbout", topic) } }),
    h("div", { class: "more-body" }, ...paragraphs.map((part) => (typeof part === "string" ? h("p", { text: part }) : part))),
  );
}

/**
 * A sentence with a "Learn more" disclosure after it. The disclosure is tied to the last word with a no-break
 * space, so that it never stands alone on a line: the word moves down with it.
 */
export function withMore(text: string, more: HTMLElement): Child[] {
  return [text.replace(/\u00a0(?=\S+$)/, " "), "\u00a0", more];
}

/** A description line, optionally followed by a "Learn more" disclosure. */
export function description(text: string, more: HTMLElement | null = null, cls = ""): HTMLElement {
  return h("div", { class: `description ${cls}`.trim() }, ...(more === null ? [text] : withMore(text, more)));
}

/** A link to another pane of the settings page, inside a sentence. `go` opens the pane and moves the focus to what the sentence is about. */
export function paneLink(pane: string, text: string, go: () => void): HTMLAnchorElement {
  return h("a", {
    href: `#${pane}`,
    text,
    onclick: (event) => {
      event.preventDefault();
      go();
    },
  });
}

/**
 * Says something in a status element so that it is read out also when it is the same text as before: an action
 * that was pressed twice and found the same thing still answers.
 */
export function announce(element: HTMLElement, text: string): void {
  element.textContent = "";
  // Emptied first and filled in the next frame: a live region reads a change, not a text that stayed.
  requestAnimationFrame(() => {
    element.textContent = text;
  });
}

/** A checkbox with its label in one row, as in Thunderbird's Settings. */
export function checkRow(id: string, label: string, onchange: (checked: boolean) => void): { row: HTMLElement; input: HTMLInputElement } {
  const input = h("input", { type: "checkbox", id, onchange: () => onchange(input.checked) });
  return { input, row: h("div", { class: "check" }, input, h("label", { for: id, text: label })) };
}

export type BarKind = "information" | "success" | "warning" | "critical";

const BAR_ICONS: Record<BarKind, IconName> = { information: "info", success: "success", warning: "warning", critical: "critical" };

/**
 * The close button of a bar that stays until the next action (a confirmation with Undo, a report, a result): the
 * same one everywhere, at the end of the bar after its other buttons. A bar that describes a state that still
 * holds (a warning, a note that something waits) has none: it goes when the state does.
 */
export function closeButton(onclick: () => void): HTMLButtonElement {
  const element = iconButton("close", t("dismiss"), onclick);
  element.dataset.focus = "close";
  return element;
}

/**
 * Where the keyboard goes on when a bar is closed and no control is named for it: the first control that follows
 * the bar in its pane and can be reached with Tab, or else the title of the pane. It is never left on nothing.
 */
export function focusAfter(element: Element): void {
  const pane = element.closest("section.pane");
  const next = [...(pane ?? document.body).querySelectorAll<HTMLElement>(FOCUSABLE)].find(
    (candidate) =>
      !element.contains(candidate) &&
      (element.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
      candidate.tabIndex >= 0 &&
      candidate.getClientRects().length > 0,
  );
  (next ?? paneTitle(element))?.focus();
}

/** A message bar: an icon, text, and optionally buttons or links that lead to the fix. */
export function bar(kind: BarKind, content: Child[], actions: Child[] = []): HTMLElement {
  return h(
    "div",
    { class: `bar ${kind}` },
    icon(BAR_ICONS[kind]),
    // An account or a service can be named by an address: inside the sentence it still breaks like one.
    h("div", { class: "bar-text" }, ...content.flatMap((part) => (typeof part === "string" ? addressed(part) : [part]))),
    actions.some((action) => action !== null && action !== undefined && action !== false) ? h("div", { class: "bar-actions" }, ...actions) : null,
  );
}

// ---------------------------------------------------------------------------
// Feedback next to a control.

export interface FieldError {
  element: HTMLElement;
  /** Shows the message under the field and marks the field invalid. Null clears both. */
  set(message: string | null): void;
}

/** The error line of a field. The field keeps the focus; screen readers hear the message at once. */
export function fieldError(field: HTMLElement, id: string): FieldError {
  const element = h("div", { class: "field-error", id, hidden: true, attrs: { role: "alert" } });
  return {
    element,
    set(message) {
      element.textContent = message ?? "";
      element.hidden = message === null;
      if (message === null) {
        field.removeAttribute("aria-invalid");
        field.removeAttribute("aria-describedby");
      } else {
        field.setAttribute("aria-invalid", "true");
        field.setAttribute("aria-describedby", id);
      }
    },
  };
}

export interface InlineStatus {
  element: HTMLElement;
  set(message: string, kind?: "plain" | "ok" | "error"): void;
  /** Like set, for a confirmation such as "Saved.": it leaves by itself after a few seconds. */
  flash(message: string): void;
  /** Something is in progress: the message with the turning ring that every busy state of the page has. */
  busy(message: string): void;
  clear(): void;
}

const FLASH_MS = 4000;

/** A short note next to a control that says what its last action did. */
export function inlineStatus(cls = ""): InlineStatus {
  const element = h("span", { class: `inline-status ${cls}`.trim(), attrs: { role: "status" } });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const status: InlineStatus = {
    element,
    set(message, kind = "plain") {
      stop();
      replace(element, ...addressed(message));
      element.className = `inline-status ${cls} ${kind}`.replace(/\s+/g, " ").trim();
      element.setAttribute("role", kind === "error" ? "alert" : "status");
    },
    busy(message) {
      status.set("", "plain");
      replace(element, h("span", { class: "spinner", attrs: { "aria-hidden": "true" } }), " ", message);
    },
    flash(message) {
      status.set(message, "ok");
      timer = setTimeout(() => {
        timer = null;
        element.textContent = "";
      }, FLASH_MS);
    },
    clear() {
      stop();
      element.textContent = "";
    },
  };
  return status;
}

/**
 * The place of a status that stands between buttons: as wide as the longest text it can say, whether it says
 * something or not, so that the buttons after it never move when it appears.
 */
export function statusSlot(status: InlineStatus, ...texts: string[]): HTMLElement {
  const longest = texts.reduce((a, b) => (b.length > a.length ? b : a), "");
  return h("span", { class: "status-slot" }, h("span", { class: "sizer", text: longest, attrs: { "aria-hidden": "true" } }), status.element);
}

// ---------------------------------------------------------------------------
// Lists that are redrawn while the user works in them.

export interface Keyed {
  key: string;
  /** Changes whenever the element has to be built again. */
  signature: string;
  build: () => HTMLElement;
}

/**
 * Brings the children of a container in line with the items, building only what
 * changed. The page is redrawn after every storage change, also while the background
 * writes the log: an element the user is working in must survive that, and the focus
 * with it. A rebuilt element gets the focus back on the control with the same
 * data-focus value.
 */
export function reconcile(container: Element, items: readonly Keyed[]): void {
  const existing = new Map<string, HTMLElement>();
  for (const child of [...container.children]) {
    const key = child instanceof HTMLElement ? child.dataset.key : undefined;
    if (child instanceof HTMLElement && key !== undefined && !existing.has(key)) {
      existing.set(key, child);
    } else {
      child.remove();
    }
  }
  // What is no longer listed goes first, so that the items that stay never have to be moved around it:
  // moving an element takes the keyboard focus off whatever it holds.
  const wanted = new Set(items.map((item) => item.key));
  let lostFocus: { kind: string | null } | null = null;
  for (const [key, leftover] of existing) {
    if (!wanted.has(key)) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && leftover.contains(active)) {
        lostFocus = { kind: active.dataset.focus ?? null };
      }
      leftover.remove();
      existing.delete(key);
    }
  }
  let previous: Element | null = null;
  for (const item of items) {
    let element = existing.get(item.key);
    if (element === undefined || element.dataset.signature !== item.signature) {
      const fresh = item.build();
      fresh.dataset.key = item.key;
      fresh.dataset.signature = item.signature;
      if (element !== undefined) {
        const active = document.activeElement;
        const focus = active instanceof HTMLElement && element.contains(active) ? (active.dataset.focus ?? null) : null;
        element.replaceWith(fresh);
        if (focus !== null) {
          [...fresh.querySelectorAll<HTMLElement>("[data-focus]")].find((candidate) => candidate.dataset.focus === focus)?.focus();
        }
      }
      element = fresh;
    }
    const expected: Element | null = previous === null ? container.firstElementChild : previous.nextElementSibling;
    if (expected !== element) {
      // An item that changes its place keeps the focus it holds (an AI service that was moved up).
      const active = document.activeElement;
      const held = active instanceof HTMLElement && element.contains(active) ? active : null;
      container.insertBefore(element, expected);
      if (held !== null && document.activeElement !== held) {
        held.focus();
      }
    }
    previous = element;
  }
  if (lostFocus !== null) {
    focusAfterRemoval(container, lostFocus.kind);
  }
}

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary';

/**
 * The item that held the keyboard focus is gone from a list: the focus goes to the
 * control of the same kind in the first item that is left, or else to the first control
 * there, or else to the title of the pane. It is never left on nothing.
 */
function focusAfterRemoval(container: Element, kind: string | null): void {
  const items = [...container.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
  const same = kind === null ? undefined : items.flatMap((item) => [...item.querySelectorAll<HTMLElement>("[data-focus]")]).find((candidate) => candidate.dataset.focus === kind);
  const target = same ?? items.map((item) => item.querySelector<HTMLElement>(FOCUSABLE)).find((candidate) => candidate !== null) ?? paneTitle(container);
  target?.focus();
}

/** The title of the pane an element is in. It can take the focus. */
export function paneTitle(element: Element): HTMLElement | null {
  return element.closest("section.pane")?.querySelector<HTMLElement>(":scope > h1") ?? null;
}

// ---------------------------------------------------------------------------
// Confirmations in place. An action that changes something says so where it happened:
// as an information bar in the group it belongs to, with Undo where the action can be
// taken back. Nothing floats over the page and nothing leaves by itself.

const ON_MAC = typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");

/** "Undo" with the shortcut that does the same, as the platform writes it. */
export function undoLabel(): string {
  return t("undoKey", ON_MAC ? "\u2318Z" : "Ctrl+Z");
}

export interface Notice {
  element: HTMLElement;
  /**
   * Shows a confirmation. It stays until the next action here, or until its close button
   * is pressed. With `undo` it carries an Undo button, and Ctrl+Z or Command+Z does the
   * same; `undone` is what it says once the action was taken back.
   */
  show(message: string, undo?: () => Promise<unknown> | void, undone?: string): void;
  clear(): void;
}

/** The notice whose Undo the keyboard shortcut runs: the last one that was shown with Undo. */
let undoOwner: { notice: Notice; run: () => void } | null = null;
let undoKeyBound = false;

function onUndoKey(event: KeyboardEvent): void {
  const target = event.target;
  const typing =
    target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
  if (undoOwner !== null && !typing && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undoOwner.run();
  }
}

/**
 * The place of a group where its confirmations appear. Put its element where the result of the action is seen.
 * `afterClose` names the control the confirmation belongs to: it takes the focus when the bar is closed. Without
 * it, or when it names none, the control that follows the bar does.
 */
export function notice(afterClose?: () => HTMLElement | null): Notice {
  // It can take the focus, for when the button that was pressed is gone: then it reads its text.
  const element = h("div", { class: "notice", tabIndex: -1, attrs: { role: "group" } });
  const self: Notice = {
    element,
    show(message, undo, undone) {
      // One level of Undo: a confirmation that offered it gives way to the next one.
      if (undoOwner !== null && undoOwner.notice !== self) {
        undoOwner.notice.clear();
      }
      undoOwner = null;
      let undoButton: HTMLButtonElement | null = null;
      if (undo !== undefined) {
        const run = (): void => {
          self.clear();
          void guard(async () => {
            await undo();
            if (undone !== undefined) {
              self.show(undone);
              // The button that was pressed is gone: the confirmation takes the focus, so that the keyboard stays here.
              element.focus({ preventScroll: true });
            }
          });
        };
        // The name says what is taken back.
        undoButton = named(button(undoLabel(), run), message);
        undoButton.dataset.focus = "undo";
        undoOwner = { notice: self, run };
        if (!undoKeyBound) {
          undoKeyBound = true;
          document.addEventListener("keydown", onUndoKey);
        }
      }
      const close = closeButton(() => {
        // The bar goes away, and the button that was pressed with it: the focus moves first, so that it is never on nothing.
        const target = afterClose?.() ?? null;
        if (target !== null && target.isConnected) {
          target.focus();
        } else {
          focusAfter(element);
        }
        self.clear();
      });
      const box = bar("information", [message], [undoButton, close]);
      box.setAttribute("role", "status");
      element.setAttribute("aria-label", message);
      replace(element, box);
    },
    clear() {
      if (undoOwner?.notice === self) {
        undoOwner = null;
      }
      element.removeAttribute("aria-label");
      replace(element);
    },
  };
  return self;
}

/**
 * Before a row of a list is removed: moves the keyboard focus to the remove button of
 * the row after it, or else of the row before it, or else to the given control, so
 * that the focus does not vanish with the row.
 */
export function focusNeighbor(row: Element, fallback: HTMLElement | null): void {
  const find = (start: Element | null, step: (element: Element) => Element | null): HTMLElement | null => {
    for (let sibling = start; sibling !== null; sibling = step(sibling)) {
      const candidate = sibling.querySelector<HTMLElement>("button.remove");
      if (candidate !== null) {
        return candidate;
      }
    }
    return null;
  };
  const target =
    find(row.nextElementSibling, (element) => element.nextElementSibling) ??
    find(row.previousElementSibling, (element) => element.previousElementSibling) ??
    fallback;
  target?.focus();
}

/** The remove button of a row: one icon everywhere, a trash can. */
export function removeButton(label: string, onclick: (event: MouseEvent) => void): HTMLButtonElement {
  const element = iconButton("trash", label, onclick, "quiet remove");
  element.dataset.focus = "remove";
  return element;
}

/**
 * A failure that belongs to no field: a bar at the top of the pane that is open, kept
 * until it is dismissed or replaced by the next one.
 */
export function reportError(message: string): void {
  const pane = document.querySelector<HTMLElement>("section.pane:not([hidden])");
  if (pane === null) {
    console.error(`Block Spam: ${message}`);
    return;
  }
  let host = pane.querySelector<HTMLElement>(":scope > .pane-error");
  if (host === null) {
    host = h("div", { class: "pane-error" });
    const title = pane.querySelector(":scope > h1");
    if (title === null) {
      pane.prepend(host);
    } else {
      title.after(host);
    }
  }
  const holder = host;
  const box = bar("critical", [message], [
    closeButton(() => {
      // The bar goes away with its button: the keyboard goes on with what follows it in the pane.
      focusAfter(holder);
      holder.remove();
    }),
  ]);
  box.setAttribute("role", "alert");
  replace(holder, box);
}

/** Runs an action. A failure is shown where the caller wants it, or else at the top of the pane. */
export async function guard(action: () => Promise<unknown>, onError?: (message: string) => void): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = errorText(error);
    if (onError === undefined) {
      reportError(message);
    } else {
      onError(message);
    }
  }
}

/**
 * A localized sentence with elements in the places of its placeholders: $1 is the
 * first part, $2 the second. For a key, a link or an address inside a sentence.
 */
export function tNodes(key: string, ...parts: (Node | string)[]): Child[] {
  const text = t(key, ...parts.map((_, index) => `\uE000${index}\uE001`));
  const pieces = text.split(/\uE000(\d+)\uE001/);
  // An element that ends the sentence (a link, a key) stays with the word before it: it never stands alone on the last line.
  const last = pieces.length - 1;
  if (last >= 2 && /^[.!?\u2026)\u201d"]*$/.test(pieces[last] ?? "")) {
    pieces[last - 2] = (pieces[last - 2] ?? "").replace(/ $/, "\u00a0");
  }
  return pieces.map((piece, index): Child => (index % 2 === 0 ? piece : (parts[Number(piece)] ?? ""))).filter((piece) => piece !== "");
}

// ---------------------------------------------------------------------------
// Dialogs.

export interface DialogOptions {
  title: string;
  /** Paragraphs of the message. */
  body: (string | Node)[];
  confirmLabel: string;
  cancelLabel?: string;
  /** For messages that can only be acknowledged. */
  hideCancel?: boolean;
  /** The confirm button deletes something: it gets the destructive style. */
  danger?: boolean;
  /** A second way to go on, shown as a neutral button next to the confirm button. */
  extraLabel?: string;
  /**
   * The button that has the focus when the dialog opens. Cancel by default, the safe
   * choice; "confirm" where confirming is the safe choice.
   */
  focus?: "confirm" | "cancel";
  /**
   * Called directly inside the click handler of the confirm button, so that it may
   * request permissions. Return false to keep the dialog open.
   */
  onConfirm?: () => Promise<boolean | void> | boolean | void;
}

export type DialogResult = "confirm" | "extra" | "cancel";

let dialogCount = 0;

/** A modal dialog. The focus moves into it, and back to where it was when it closes. */
/** Windows puts the confirming button first, macOS and Linux put it last. Thunderbird's own dialogs follow the platform, and so do these. */
const CONFIRM_FIRST = typeof navigator !== "undefined" && navigator.platform.startsWith("Win");

export function dialog(options: DialogOptions): Promise<DialogResult> {
  return new Promise((resolve) => {
    dialogCount += 1;
    const titleId = `dialog-title-${dialogCount}`;
    const bodyId = `dialog-text-${dialogCount}`;
    const opener = document.activeElement;
    // The title names the dialog and its text describes it, so that the text is read when the dialog opens.
    const box = h("dialog", { class: "modal", attrs: { "aria-labelledby": titleId, "aria-describedby": bodyId } });
    const problem = h("p", { class: "field-error", hidden: true, attrs: { role: "alert" } });
    let settled = false;
    const close = (result: DialogResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      box.close();
      box.remove();
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
      }
      if (document.activeElement === null || document.activeElement === document.body) {
        // The control that opened the dialog is gone or cannot take the focus any more: the title of the open pane takes it.
        document.querySelector<HTMLElement>("section.pane:not([hidden]) > h1")?.focus();
      }
      resolve(result);
    };
    const confirm = button(
      options.confirmLabel,
      () => {
        confirm.disabled = true;
        problem.hidden = true;
        void (async () => {
          try {
            const keepOpen = (await options.onConfirm?.()) === false;
            if (keepOpen) {
              confirm.disabled = false;
              return;
            }
            close("confirm");
          } catch (error) {
            confirm.disabled = false;
            problem.textContent = errorText(error);
            problem.hidden = false;
          }
        })();
      },
      options.danger === true ? "destructive" : "primary",
    );
    const cancel = options.hideCancel === true ? null : button(options.cancelLabel ?? t("cancel"), () => close("cancel"));
    const extra = options.extraLabel === undefined ? null : button(options.extraLabel, () => close("extra"));
    append(box, [
      h("h2", { id: titleId, text: options.title }),
      h("div", { id: bodyId, class: "dialog-text" }, ...options.body.map((part) => (typeof part === "string" ? h("p", { text: part }) : part))),
      problem,
      h("div", { class: "dialog-actions" }, ...(CONFIRM_FIRST ? [confirm, extra, cancel] : [cancel, extra, confirm])),
    ]);
    box.addEventListener("cancel", (event) => {
      event.preventDefault();
      close("cancel");
    });
    document.body.appendChild(box);
    box.showModal();
    (options.focus === "confirm" || cancel === null ? confirm : cancel).focus();
  });
}

/** Offers a file that is packaged with the add-on for saving, under the given name. */
export function savePackaged(path: string, filename: string): void {
  const link = h("a", { href: browser.runtime.getURL(path) });
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** Offers a text file for download. */
export function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = h("a", { href: url });
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
}
