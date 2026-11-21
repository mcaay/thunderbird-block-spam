// The names of the four commands. Kept free of other imports, so that the popup can
// use them without pulling in the rest of the core.

export const COMMANDS = ["block-address", "block-domain", "trust-address", "trust-domain"] as const;
export type CommandName = (typeof COMMANDS)[number];

export function isCommandName(value: unknown): value is CommandName {
  return typeof value === "string" && (COMMANDS as readonly string[]).includes(value);
}
