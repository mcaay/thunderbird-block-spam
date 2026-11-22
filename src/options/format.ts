// Formatting shared by the settings page and the popup. No DOM, no Thunderbird API.

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function clock(date: Date, locale?: string): string {
  return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/**
 * A moment as short as it can be said: the time for today ("20:35"), day and month
 * for this year, the whole date for older ones.
 */
export function formatShortTime(time: number, now: number, locale?: string): string {
  const date = new Date(time);
  const today = new Date(now);
  if (sameDay(date, today)) {
    return clock(date, locale);
  }
  return date.getFullYear() === today.getFullYear()
    ? date.toLocaleDateString(locale, { day: "numeric", month: "numeric" })
    : date.toLocaleDateString(locale, { day: "numeric", month: "numeric", year: "numeric" });
}

/**
 * A moment in two parts: the date, when it is not today (day and month for this year,
 * the whole date for older ones), and the time of day. The log shows the date above
 * the time, so that the column is as wide as the longer of the two, not as their sum.
 */
export function logTimeParts(time: number, now: number, locale?: string): { date: string | null; clock: string } {
  const date = new Date(time);
  return { date: sameDay(date, new Date(now)) ? null : formatShortTime(time, now, locale), clock: clock(date, locale) };
}

/** The same in one line: "20:35" for today, "21.11, 20:35" for another day. */
export function formatLogTime(time: number, now: number, locale?: string): string {
  const parts = logTimeParts(time, now, locale);
  return parts.date === null ? parts.clock : `${parts.date}, ${parts.clock}`;
}

/** The complete date and time, in numbers only, for tooltips. */
export function formatFullTime(time: number, locale?: string): string {
  return new Date(time).toLocaleString(locale, { dateStyle: "short", timeStyle: "medium" });
}

export function formatDate(time: number, locale?: string): string {
  return new Date(time).toLocaleDateString(locale);
}

/** A score with two decimals, written the way the given language writes numbers: 0.97, or 0,97 in Polish. */
export function formatScore(score: number | null, locale = "en"): string {
  return score === null ? "" : score.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * The parts of an address or a domain between which a line may break: after the "@"
 * and before every dot. Joined again they give the value.
 */
export function breakableParts(value: string): string[] {
  return value.split(/(?<=@)|(?=\.)/).filter((part) => part !== "");
}

const MAC_MODIFIERS: Record<string, string> = { MacCtrl: "⌃", Alt: "⌥", Shift: "⇧", Ctrl: "⌘", Command: "⌘" };
/** The order Apple writes modifiers in. */
const MAC_ORDER = ["⌃", "⌥", "⇧", "⌘"];
const KEY_NAMES: Record<string, string> = { Comma: ",", Period: ".", Up: "↑", Down: "↓", Left: "←", Right: "→" };

/**
 * A shortcut as Thunderbird reports it ("Alt+Shift+B") the way the platform writes
 * it: with the modifier glyphs on macOS ("⌥⇧B"), unchanged elsewhere.
 */
export function formatShortcut(shortcut: string, mac: boolean): string {
  if (!mac) {
    return shortcut;
  }
  const modifiers: string[] = [];
  let key = "";
  for (const part of shortcut.split("+").map((item) => item.trim())) {
    const glyph = MAC_MODIFIERS[part];
    if (glyph === undefined) {
      key = KEY_NAMES[part] ?? part;
    } else {
      modifiers.push(glyph);
    }
  }
  modifiers.sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b));
  return `${modifiers.join("")}${key}`;
}

/** The detail of a list decision in the log, "value [scope]", taken apart. Null for any other detail. */
export function parseEntryDetail(detail: string): { value: string; scope: string } | null {
  const match = /^(\S+) \[([^[\]]+)\]$/.exec(detail);
  return match === null ? null : { value: match[1] as string, scope: match[2] as string };
}

/** Whether a text contains every word of a search, in any order and any case. */
export function matchesSearch(needle: string, ...haystacks: string[]): boolean {
  const text = haystacks.join("\n").toLowerCase();
  return needle
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "")
    .every((word) => text.includes(word));
}
