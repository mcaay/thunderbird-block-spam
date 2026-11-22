// The state of protection as the settings page and the popup show it: one icon and a
// few words, the same element in the header of the popup, under the name of the add-on
// in the category list and next to the heading "Protection".

import { PROTECTION_STATES } from "../core/problems";
import type { ProtectionState } from "../core/problems";
import { tCode, tn } from "../tb/i18n";
import { replace } from "./dom";
import { icon } from "./icons";
import type { IconName } from "./icons";

const STATE_ICONS: Record<ProtectionState, IconName> = {
  invalid: "warning",
  "no-account": "warning",
  problems: "warning",
  waiting: "clock",
  observing: "success",
  on: "success",
  off: "off",
};

/** The state in words. Problems are counted: "On, 2 problems". */
export function stateText(kind: ProtectionState, problems: number): string {
  return kind === "problems" ? tn("stateProblems", problems) : tCode("state", kind);
}

/** Fills the element with the icon and the words of the state, only when they changed. Returns the words. */
export function drawState(element: HTMLElement, kind: ProtectionState, problems: number): string {
  const text = stateText(kind, problems);
  const signature = `${kind}|${text}`;
  if (element.dataset.state !== signature) {
    element.dataset.state = signature;
    element.classList.remove(...PROTECTION_STATES);
    element.classList.add("state", kind);
    replace(element, icon(STATE_ICONS[kind]), text);
  }
  return text;
}
