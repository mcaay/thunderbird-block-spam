import type { Model } from "./model";

/** The panes of the settings page. Each is one category of the list on the left. */
export const PANES = ["overview", "lists", "log", "learning", "incoming", "ai", "shortcuts", "advanced", "backup"] as const;
export type PaneId = (typeof PANES)[number];

export function isPaneId(value: string): value is PaneId {
  return (PANES as readonly string[]).includes(value);
}

/** What a link into a pane wants to be shown there. */
export type Intent =
  | { kind: "ai-add" }
  | { kind: "ai-edit"; id: string }
  | { kind: "screening"; accountId: string }
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
