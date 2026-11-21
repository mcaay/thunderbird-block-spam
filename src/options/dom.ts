// DOM helpers shared by the settings page and the popup. Content is always set as
// text, never as HTML.

import { t, tCode } from "../tb/i18n";
import { RequestError } from "../tb/protocol";
import { breakableParts } from "./format";
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
 */
export function setUnavailable<T extends HTMLElement>(element: T, unavailable: boolean): T {
  if (unavailable) {
    element.setAttribute("aria-disabled", "true");
  } else {
    element.removeAttribute("aria-disabled");
  }
  return element;
}

export function isUnavailable(element: Element): boolean {
  return element.getAttribute("aria-disabled") === "true";
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

/** An address or a domain whose lines break only after the "@" and before a dot. */
export function address(value: string, cls = "address"): HTMLElement {
  const span = h("span", { class: cls });
  breakableParts(value).forEach((part, index) => {
    if (index > 0) {
      span.appendChild(document.createElement("wbr"));
    }
    span.appendChild(document.createTextNode(part));
  });
  return span;
}

/** A link to a page outside Thunderbird. It opens in the default browser. */
export function externalLink(label: string, url: string): HTMLAnchorElement {
  return h("a", {
    href: url,
    text: label,
    onclick: (event) => {
      event.preventDefault();
      void browser.windows.openDefaultBrowser(url).catch((error: unknown) => toast(errorText(error), { kind: "error" }));
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

/** A description line, optionally followed by a "Learn more" disclosure. */
export function description(text: string, more: HTMLElement | null = null, cls = ""): HTMLElement {
  return h("div", { class: `description ${cls}`.trim() }, text, more === null ? null : " ", more);
}

/** A checkbox with its label in one row, as in Thunderbird's Settings. */
export function checkRow(id: string, label: string, onchange: (checked: boolean) => void): { row: HTMLElement; input: HTMLInputElement } {
  const input = h("input", { type: "checkbox", id, onchange: () => onchange(input.checked) });
  return { input, row: h("div", { class: "check" }, input, h("label", { for: id, text: label })) };
}

export type BarKind = "information" | "success" | "warning" | "critical";

const BAR_ICONS: Record<BarKind, IconName> = { information: "info", success: "success", warning: "warning", critical: "critical" };

/** A message bar: an icon, text, and optionally buttons or links that lead to the fix. */
export function bar(kind: BarKind, content: Child[], actions: Child[] = []): HTMLElement {
  return h(
    "div",
    { class: `bar ${kind}` },
    icon(BAR_ICONS[kind]),
    h("div", { class: "bar-text" }, ...content),
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
      element.textContent = message;
      element.className = `inline-status ${cls} ${kind}`.replace(/\s+/g, " ").trim();
      element.setAttribute("role", kind === "error" ? "alert" : "status");
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
  let previous: Element | null = null;
  for (const item of items) {
    let element = existing.get(item.key);
    existing.delete(item.key);
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
      container.insertBefore(element, expected);
    }
    previous = element;
  }
  for (const leftover of existing.values()) {
    leftover.remove();
  }
}

// ---------------------------------------------------------------------------
// Toasts: confirmations of actions that have no visible result on the page, with
// Undo where undoing is possible, and failures that belong to no field.

export interface ToastOptions {
  kind?: "info" | "error";
  /** Offers Undo. The toast then stays longer, and Ctrl+Z or Command+Z does the same. */
  undo?: () => Promise<unknown> | void;
}

const TOAST_MS = 5000;
const TOAST_UNDO_MS = 10000;

let currentToast: { box: HTMLElement; timer: ReturnType<typeof setTimeout> | null; undo: (() => void) | null } | null = null;

function closeToast(): void {
  if (currentToast === null) {
    return;
  }
  if (currentToast.timer !== null) {
    clearTimeout(currentToast.timer);
  }
  currentToast.box.remove();
  currentToast = null;
}

function onUndoKey(event: KeyboardEvent): void {
  const target = event.target;
  const typing =
    target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
  if (currentToast?.undo != null && !typing && (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
    event.preventDefault();
    currentToast.undo();
  }
}

export function toast(message: string, options: ToastOptions = {}): void {
  closeToast();
  const isError = options.kind === "error";
  let host = document.getElementById("toasts");
  if (host === null) {
    host = h("div", { id: "toasts" });
    document.body.appendChild(host);
    document.addEventListener("keydown", onUndoKey);
  }
  const box = h("div", { class: `toast${isError ? " error" : ""}`, attrs: { role: isError ? "alert" : "status" } });
  const undoAction = options.undo;
  const undo =
    undoAction === undefined
      ? null
      : (): void => {
          closeToast();
          void guard(async () => {
            await undoAction();
          });
        };
  append(box, [
    isError ? icon("critical") : null,
    h("span", { class: "toast-text", text: message }),
    undo === null ? null : button(t("undo"), undo),
    iconButton("close", t("dismiss"), () => closeToast()),
  ]);
  host.appendChild(box);
  const state: NonNullable<typeof currentToast> = { box, timer: null, undo };
  currentToast = state;
  // A failure stays until it is dismissed. Everything else leaves by itself, but not
  // while the pointer or the keyboard focus rests on it.
  if (!isError) {
    const arm = (): void => {
      state.timer = setTimeout(
        () => {
          if (currentToast === state) {
            closeToast();
          }
        },
        undo === null ? TOAST_MS : TOAST_UNDO_MS,
      );
    };
    const hold = (): void => {
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    };
    box.addEventListener("mouseenter", hold);
    box.addEventListener("focusin", hold);
    box.addEventListener("mouseleave", arm);
    box.addEventListener("focusout", arm);
    arm();
  }
}

/** Runs an action. A failure is shown where the caller wants it, or else as a toast. */
export async function guard(action: () => Promise<unknown>, onError?: (message: string) => void): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = errorText(error);
    if (onError === undefined) {
      toast(message, { kind: "error" });
    } else {
      onError(message);
    }
  }
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
    const opener = document.activeElement;
    const box = h("dialog", { class: "modal", attrs: { "aria-labelledby": titleId } });
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
      ...options.body.map((part) => (typeof part === "string" ? h("p", { text: part }) : part)),
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
