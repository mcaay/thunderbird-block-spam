// Fields that show a stored setting. The page is redrawn after every storage change,
// often while the background writes the log, and must never overwrite an edit.

/** Inclusive end of a date input's local day, also across daylight-saving changes. */
export function endOfLocalDay(start: number): number {
  const next = new Date(start);
  return next.setDate(next.getDate() + 1) - 1;
}

/**
 * Whether a field may be redrawn with the stored value: never while it has the focus,
 * and not while it holds an edit that was not saved. `shown` is what the page put
 * into the field last. An edit counts as saved once the stored value equals it.
 */
export function mayRedraw(
  field: { value: string; focused: boolean },
  shown: string | null,
  stored: string,
  same: (a: string, b: string) => boolean = (a, b) => a === b,
): boolean {
  if (field.focused) {
    return false;
  }
  return shown === null || field.value === shown || same(field.value, stored);
}

/** Two cutoff texts that mean the same number, for example "0.9", "0.90" and "0,9" (a comma is the decimal sign of many languages). */
export function sameNumber(a: string, b: string): boolean {
  const number = (text: string): number => Number(text.trim().replace(",", "."));
  return a.trim() !== "" && b.trim() !== "" && number(a) === number(b);
}

/**
 * The number a cutoff field holds, for what a screen reader is told about it: null while the text is not a number
 * from 0 to 1. A comma is read as the decimal sign.
 */
export function cutoffNumber(text: string): number | null {
  const value = Number(text.trim().replace(",", "."));
  return text.trim() === "" || !Number.isFinite(value) || value < 0 || value > 1 ? null : value;
}

/** Two label lists that are the same once split at commas and trimmed. */
export function sameLabels(a: string, b: string): boolean {
  const normalize = (text: string): string =>
    text
      .split(",")
      .map((label) => label.trim())
      .filter((label) => label !== "")
      .join(", ");
  return normalize(a) === normalize(b);
}
