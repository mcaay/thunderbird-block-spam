import type { Model } from "./model";

/** The panes of the settings page. Each is one category of the list on the left. */
export const PANES = ["overview", "lists", "log", "learning", "incoming", "ai", "block-and-trust", "advanced", "backup"] as const;
export type PaneId = (typeof PANES)[number];

export function isPaneId(value: string): value is PaneId {
  return (PANES as readonly string[]).includes(value);
}

/** Addresses of panes under names they had before: links and bookmarks to them keep working. */
const FORMER_NAMES: Record<string, PaneId> = { shortcuts: "block-and-trust" };

/** The pane a fragment of the address names, or null when it names none. */
export function paneOf(fragment: string): PaneId | null {
  return isPaneId(fragment) ? fragment : (FORMER_NAMES[fragment] ?? null);
}

/** What a link into a pane wants to be shown there. */
export type Intent =
  | { kind: "ai-add" }
  /** `focus` names the field the link is about: the key, for a warning about a rejected or a missing key. */
  | { kind: "ai-edit"; id: string; focus?: "key" }
  /** The row of a service, for a warning that several services share. */
  | { kind: "ai-service"; id: string }
  /** The control that switches protection on: setup step 3, or else the switch itself. */
  | { kind: "protect" }
  | { kind: "screening"; accountId: string }
  /** The menu that says what happens to mail without an AI verdict. */
  | { kind: "no-verdict" }
  | { kind: "log-entry"; key: string };

/** One pane of the settings page. It builds its fixed elements once and fills them on render. */
export interface Section {
  render(model: Model): void;
  /** Called after the pane was opened through a link that carries an intent. */
  reveal?(intent: Intent): void;
  /** True while the pane holds text that was typed but not saved. */
  unsaved?(): boolean;
  /** Called when another pane is opened instead of this one. */
  leave?(): void;
}

/** What the page offers its panes. */
export interface Shell {
  /** Opens a pane and moves the focus to its title, or to what the intent names. */
  go(pane: PaneId, intent?: Intent): void;
  /** While a scan, a sign-in or a scoring run is in progress, the page asks the background for its state once a second. */
  startPolling(): void;
  /** Reads storage and the accounts again and redraws. */
  refresh(): Promise<void>;
}
