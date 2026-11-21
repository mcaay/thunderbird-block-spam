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

/** Two cutoff texts that mean the same number, for example "0.9" and "0.90". */
export function sameNumber(a: string, b: string): boolean {
  return a.trim() !== "" && b.trim() !== "" && Number(a) === Number(b);
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
