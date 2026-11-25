// DOM helpers shared by the settings page and the popup. Content is always set as
// text, never as HTML.

import { t, tCode } from "../tb/i18n";
import { RequestError } from "../tb/protocol";
import { addressPieces, breakableParts } from "./format";
import { icon } from "./icons";
import type { IconName } from "./icons";
import { isRovingKey, rovingMove } from "./roving";

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
// A table that pages (Lists, Log) is one tab stop, as Thunderbird's own lists are.

/** The controls of a table row that the keyboard reaches. */
const ROW_CONTROLS = "button, a[href]";

export interface TabStop {
  /** Call after the rows were drawn: rows that are new join, and exactly one control stays reachable with Tab. */
  sync(): void;
  /** The control Tab enters the table at, or null while no row has one. */
  stop(): HTMLElement | null;
}

/**
 * Makes the body of a table one tab stop. Exactly one control of it can be reached with Tab: the one in the row that
 * was focused last, or else the first. Up and Down move to the same control of the next row (or to its first one),
 * Left and Right between the controls of a row, Home and End to the first and the last row, and the next Tab leaves
 * the table for what follows it. Whatever receives the focus inside (after a removal, Undo, an action of a row, a
 * redraw, a click) becomes the tab stop. The table keeps its native semantics: only tabindex values change.
 */
export function oneTabStop(body: HTMLElement): TabStop {
  /** The row and the kind of control that were focused last. Rows are told apart by their key, so a row that is drawn anew stays the same row. */
  let lastRow: string | null = null;
  let lastKind: string | null = null;
  let stop: HTMLElement | null = null;
  const rowsOf = (): HTMLElement[] => [...body.children].filter((row): row is HTMLElement => row instanceof HTMLElement);
  const controlsOf = (row: Element): HTMLElement[] => [...row.querySelectorAll<HTMLElement>(ROW_CONTROLS)];
  /** The control of a row of the given kind, or else its first one. */
  const pick = (row: Element, kind: string | null): HTMLElement | null => {
    const controls = controlsOf(row);
    return (kind === null ? undefined : controls.find((control) => control.dataset.focus === kind)) ?? controls[0] ?? null;
  };

  function sync(): void {
    const rows = rowsOf();
    const active = document.activeElement;
    if (active instanceof HTMLElement && body.contains(active)) {
      // What has the focus decides: a control is the tab stop itself, a row that was focused as a whole gives its first control.
      const row = active.closest<HTMLElement>("tr");
      lastRow = row?.dataset.key ?? null;
      lastKind = active.matches(ROW_CONTROLS) ? (active.dataset.focus ?? null) : null;
      stop = active.matches(ROW_CONTROLS) ? active : row === null ? null : pick(row, null);
    } else {
      const row = lastRow === null ? undefined : rows.find((candidate) => candidate.dataset.key === lastRow);
      stop = row === undefined ? null : pick(row, lastKind);
    }
    // The row that was focused last is gone, or none was focused yet: the first control of the table.
    stop ??= rows.map((row) => pick(row, null)).find((control) => control !== null) ?? null;
    for (const control of body.querySelectorAll<HTMLElement>(ROW_CONTROLS)) {
      const wanted = control === stop ? 0 : -1;
      if (control.tabIndex !== wanted) {
        control.tabIndex = wanted;
      }
    }
  }

  body.addEventListener("focusin", sync);
  body.addEventListener("keydown", (event) => {
    const target = event.target;
    if (!isRovingKey(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !(target instanceof HTMLElement)) {
      return;
    }
    const row = target.closest("tr");
    const rows = rowsOf();
    const from = row === null ? -1 : rows.indexOf(row as HTMLElement);
    if (from === -1 || !(target === row || target.matches(ROW_CONTROLS))) {
      return;
    }
    // Inside the table these keys move the focus and nothing else: the page does not scroll under them.
    event.preventDefault();
    const controls = controlsOf(rows[from] as HTMLElement);
    if (target === row && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      // The row as a whole has the focus (it was scrolled to): its first control takes it.
      controls[0]?.focus();
      return;
    }
    const place = rovingMove(event.key, { row: from, control: Math.max(0, controls.indexOf(target)) }, rows.map((candidate) => controlsOf(candidate).length));
    if (place === null) {
      return;
    }
    const next = rows[place.row] as HTMLElement;
    // In the same row the neighbouring control, in another row the control of the same kind or else its first one.
    const control = place.row === from ? (controls[place.control] ?? null) : pick(next, target === row ? null : (target.dataset.focus ?? null));
    control?.focus();
  });
  sync();
  return { sync, stop: () => stop };
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
  /** The confirmation keeps its place and gives up its Undo: for when the next action offers Undo right under it, where a bar that left would move everything below. */
  settle?(): void;
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
    settle() {
      if (undoOwner?.notice === self) {
        undoOwner = null;
      }
      element.querySelector('button[data-focus="undo"]')?.remove();
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

// ---------------------------------------------------------------------------
// Removing a row never moves anything under the pointer.

/**
 * The rows of one list that were removed and still stand in their place. A removed row is drawn as a quiet row
 * that says it was removed, with Undo where its remove button was and the close button after it. It stays until
 * it is closed, until the next other action in its list or until the pane is left (`clear`): only then do the
 * rows below move up. Rows that are removed one after the other all keep their place meanwhile, so that the
 * pointer never lands on a row that was not aimed at. Undo is one level, as everywhere: the newest removal has it.
 */
export interface RemovedRows {
  /**
   * Removes the row that `row` draws (an item with a `data-key`). `remove` takes it off the stored list, `undo`
   * puts it back exactly as it was, and `undone` is what is said once it is back.
   */
  remove(row: HTMLElement, message: string, remove: () => Promise<unknown>, undo: () => Promise<unknown>, undone: string): void;
  /**
   * The keys of the rows to draw, in their order: the given keys of the list as it is stored, with the removed rows
   * in the places they had. Where one instance serves several lists, `prefix` names the list: only the removed rows
   * whose key starts with it belong to it.
   */
  order(keys: readonly string[], prefix?: string): string[];
  /** Whether the row with this key is drawn as a removed row. */
  has(key: string): boolean;
  /** What a removed row holds: the sentence, Undo for the newest removal, the close button. `focus` is the kind of the remove button it stands for. */
  content(key: string, focus?: string): Child[];
  /** Changes whenever the removed rows whose key starts with the prefix have to be drawn anew. */
  signature(prefix?: string): string;
  /** The removed rows go, and the rows below them move up. */
  clear(): void;
}

interface RemovedRow {
  message: string;
  /** The row it stood under, and its place among the rows, as they were when it was removed. */
  after: string | null;
  index: number;
  /** Seen missing from the stored list: when its key is listed again after that, the row is back and is drawn as itself. */
  gone: boolean;
  restored: boolean;
  restoring: boolean;
  undo: (() => Promise<unknown>) | null;
  undone: string;
}

/** Where a row that came back with Undo is said to a screen reader: the row itself is back in its place and says the rest. */
let restoredLive: HTMLElement | null = null;

export function removedRows(redraw: () => void): RemovedRows {
  const rows = new Map<string, RemovedRow>();
  /** One level of Undo: when another confirmation offers it, the removed rows keep their place and lose theirs. */
  const owner: Notice = {
    element: h("div"),
    show() {},
    clear() {
      if (dropUndo()) {
        redraw();
      }
    },
  };
  function dropUndo(): boolean {
    let changed = false;
    for (const entry of rows.values()) {
      changed ||= entry.undo !== null;
      entry.undo = null;
    }
    if (undoOwner?.notice === owner) {
      undoOwner = null;
    }
    return changed;
  }
  function forget(key: string): void {
    const entry = rows.get(key);
    if (entry === undefined) {
      return;
    }
    rows.delete(key);
    if (entry.undo !== null && undoOwner?.notice === owner) {
      undoOwner = null;
    }
    // A removed row that stood under this one now stands under what this one stood under.
    for (const other of rows.values()) {
      if (other.after === key) {
        other.after = entry.after;
      }
    }
  }
  function run(key: string): void {
    const entry = rows.get(key);
    if (entry === undefined || entry.undo === null || entry.restoring) {
      return;
    }
    const undo = entry.undo;
    entry.restoring = true;
    void guard(async () => {
      try {
        await undo();
        // The row is drawn as itself again as soon as the stored list has it.
        entry.restored = true;
        redraw();
        if (restoredLive === null) {
          restoredLive = h("div", { class: "visually-hidden", attrs: { role: "status" } });
          document.body.appendChild(restoredLive);
        }
        announce(restoredLive, entry.undone);
      } finally {
        entry.restoring = false;
      }
    });
  }
  return {
    remove(row, message, remove, undo, undone) {
      const key = row.dataset.key;
      if (key === undefined) {
        return;
      }
      if (undoOwner !== null && undoOwner.notice !== owner) {
        undoOwner.notice.clear();
      }
      dropUndo();
      const previous = row.previousElementSibling;
      rows.set(key, {
        message,
        after: previous instanceof HTMLElement ? (previous.dataset.key ?? null) : null,
        index: row.parentElement === null ? 0 : [...row.parentElement.children].indexOf(row),
        gone: false,
        restored: false,
        restoring: false,
        undo,
        undone,
      });
      undoOwner = { notice: owner, run: () => run(key) };
      if (!undoKeyBound) {
        undoKeyBound = true;
        document.addEventListener("keydown", onUndoKey);
      }
      // First the quiet row in the place of the row, then the removal itself: nothing moves in between.
      redraw();
      void guard(async () => {
        try {
          await remove();
        } catch (error) {
          forget(key);
          redraw();
          throw error;
        }
      });
    },
    order(keys, prefix = "") {
      const present = new Set(keys);
      for (const [key, entry] of [...rows]) {
        if (!key.startsWith(prefix)) {
          continue;
        }
        if (!present.has(key)) {
          entry.gone = true;
        } else if (entry.gone || entry.restored) {
          forget(key);
        }
      }
      const result = [...keys];
      let waiting = [...rows.keys()].filter((key) => key.startsWith(prefix) && !present.has(key));
      // A removed row stands under the row it stood under. Where that one is gone too, it keeps the place it had by its number.
      for (let placed = true; placed && waiting.length > 0; ) {
        placed = false;
        for (const key of waiting) {
          const after = rows.get(key)?.after ?? null;
          const at = after === null ? 0 : result.indexOf(after) + 1;
          if (after === null || at > 0) {
            result.splice(at, 0, key);
            waiting = waiting.filter((other) => other !== key);
            placed = true;
            break;
          }
        }
      }
      for (const key of waiting) {
        result.splice(Math.min(rows.get(key)?.index ?? result.length, result.length), 0, key);
      }
      return result;
    },
    has: (key) => rows.has(key),
    content(key, focus = "remove") {
      const entry = rows.get(key);
      if (entry === undefined) {
        return [];
      }
      // The sentence is a status: a screen reader hears the removal, and the name of Undo says what is taken back.
      const text = h("span", { class: "removed-text", attrs: { role: "status" } }, ...addressed(entry.message));
      const undoButton = entry.undo === null ? null : named(button(undoLabel(), () => run(key), "small"), entry.message);
      if (undoButton !== null) {
        // It stands where the remove button was and is the control of the same kind: the keyboard stays on it when the row changes.
        undoButton.dataset.focus = focus;
      }
      const close = closeButton(() => {
        // The quiet row goes: the keyboard goes on with the row next to it, or with what follows the list.
        const row = close.closest<HTMLElement>("[data-key]");
        if (row !== null && row.contains(document.activeElement)) {
          focusNeighbor(row, null);
          if (row.contains(document.activeElement)) {
            focusAfter(row);
          }
        }
        forget(key);
        redraw();
      });
      return [text, undoButton, close];
    },
    signature(prefix = "") {
      return JSON.stringify([...rows].filter(([key]) => key.startsWith(prefix)).map(([key, entry]) => [key, entry.message, entry.undo !== null]));
    },
    clear() {
      if (rows.size === 0) {
        return;
      }
      dropUndo();
      rows.clear();
      redraw();
    },
  };
}
