// The four shortcuts as the platform writes them: "⌥B" on macOS, "Alt+B" elsewhere.

import { isCommandName } from "../core/commandNames";
import type { CommandName } from "../core/commandNames";
import { formatShortcut } from "./format";

export interface ShortcutKeys {
  mac: boolean;
  /** The key of each command that has one. */
  keys: Map<CommandName, string>;
}

let mac: Promise<boolean> | null = null;

export function isMac(): Promise<boolean> {
  mac ??= browser.runtime
    .getPlatformInfo()
    .then((info) => info.os === "mac")
    .catch(() => false);
  return mac;
}

/** Reads the current bindings. They can be changed in Thunderbird at any time, so they are not kept. */
export async function loadShortcutKeys(): Promise<ShortcutKeys> {
  const [onMac, commands] = await Promise.all([isMac(), browser.commands.getAll()]);
  const keys = new Map<CommandName, string>();
  for (const command of commands) {
    if (isCommandName(command.name) && command.shortcut !== undefined && command.shortcut !== "") {
      keys.set(command.name, formatShortcut(command.shortcut, onMac));
    }
  }
  return { mac: onMac, keys };
}
