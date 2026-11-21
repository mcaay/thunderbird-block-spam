// Small DOM helpers shared by the settings page and the popup. Content is always set
// as text, never as HTML.

import { t } from "../tb/i18n";

type Child = Node | string | null | undefined | false;

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
  rows?: number;
  checked?: boolean;
  disabled?: boolean;
  selected?: boolean;
  readOnly?: boolean;
  colSpan?: number;
  onclick?: (event: MouseEvent) => void;
  onchange?: (event: Event) => void;
  oninput?: (event: Event) => void;
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

export function button(label: string, onclick: (event: MouseEvent) => void, cls = ""): HTMLButtonElement {
  return h("button", { type: "button", text: label, class: cls, onclick });
}

export function formatTime(time: number): string {
  return new Date(time).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

export function formatDate(time: number): string {
  return new Date(time).toLocaleDateString();
}

export function formatScore(score: number | null): string {
  return score === null ? "" : score.toFixed(2);
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** Shows a short message at the bottom of the page. */
export function toast(message: string, kind: "info" | "error" = "info"): void {
  let box = document.getElementById("toast");
  if (box === null) {
    box = h("div", { id: "toast" });
    box.setAttribute("role", "status");
    document.body.appendChild(box);
  }
  box.textContent = message;
  box.className = `toast ${kind} visible`;
  if (toastTimer !== null) {
    clearTimeout(toastTimer);
  }
  toastTimer = setTimeout(() => {
    box.className = "toast";
  }, kind === "error" ? 9000 : 4000);
}

/** Runs an action and shows its error, if any, as a toast. */
export async function guard(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  }
}

export interface DialogOptions {
  title: string;
  /** Paragraphs of the message. */
  body: (string | Node)[];
  confirmLabel: string;
  cancelLabel?: string;
  /** For messages that can only be acknowledged. */
  hideCancel?: boolean;
  danger?: boolean;
  /**
   * Called directly inside the click handler of the confirm button, so that it may
   * request permissions. Return false to keep the dialog open.
   */
  onConfirm?: () => Promise<boolean | void> | boolean | void;
}

/** A modal dialog. Resolves to true when confirmed. */
export function dialog(options: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const box = h("dialog", { class: "modal" });
    let settled = false;
    const close = (result: boolean): void => {
      if (!settled) {
        settled = true;
        box.close();
        box.remove();
        resolve(result);
      }
    };
    const confirm = button(
      options.confirmLabel,
      () => {
        confirm.disabled = true;
        void (async () => {
          try {
            const keepOpen = (await options.onConfirm?.()) === false;
            if (keepOpen) {
              confirm.disabled = false;
              return;
            }
            close(true);
          } catch (error) {
            confirm.disabled = false;
            toast(error instanceof Error ? error.message : String(error), "error");
          }
        })();
      },
      options.danger === true ? "danger" : "primary",
    );
    append(box, [
      h("h3", { text: options.title }),
      ...options.body.map((part) => (typeof part === "string" ? h("p", { text: part }) : part)),
      h(
        "div",
        { class: "actions" },
        options.hideCancel === true ? null : button(options.cancelLabel ?? t("cancel"), () => close(false)),
        confirm,
      ),
    ]);
    box.addEventListener("cancel", (event) => {
      event.preventDefault();
      close(false);
    });
    document.body.appendChild(box);
    box.showModal();
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
