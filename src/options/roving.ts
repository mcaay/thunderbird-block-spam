// Where the arrow keys lead inside a table that is one tab stop. No DOM: the page
// turns rows and controls into numbers, and the answer back into the focus.

export const ROVING_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"] as const;
export type RovingKey = (typeof ROVING_KEYS)[number];

export function isRovingKey(key: string): key is RovingKey {
  return (ROVING_KEYS as readonly string[]).includes(key);
}

export interface RovingPlace {
  /** The index of the row. */
  row: number;
  /** The index of the control inside its row. */
  control: number;
}

/**
 * The place a key moves the focus to, or null when it stays where it is. `counts` says how many controls each row
 * has. Up and Down lead to the next row that has a control, Home and End to the first and the last such row: there
 * the caller takes the control of the same kind, or else the first one, so `control` stays what it was. Left and
 * Right lead to the neighbouring control of the same row.
 */
export function rovingMove(key: RovingKey, from: RovingPlace, counts: readonly number[]): RovingPlace | null {
  const has = (row: number): boolean => (counts[row] ?? 0) > 0;
  const to = (row: number): RovingPlace | null => (row === from.row ? null : { row, control: from.control });
  switch (key) {
    case "ArrowLeft":
      return from.control > 0 ? { row: from.row, control: from.control - 1 } : null;
    case "ArrowRight":
      return from.control + 1 < (counts[from.row] ?? 0) ? { row: from.row, control: from.control + 1 } : null;
    case "ArrowUp":
      for (let row = from.row - 1; row >= 0; row -= 1) {
        if (has(row)) {
          return to(row);
        }
      }
      return null;
    case "ArrowDown":
      for (let row = from.row + 1; row < counts.length; row += 1) {
        if (has(row)) {
          return to(row);
        }
      }
      return null;
    case "Home": {
      const first = counts.findIndex((count) => count > 0);
      return first === -1 ? null : to(first);
    }
    default: {
      const last = counts.findLastIndex((count) => count > 0);
      return last === -1 ? null : to(last);
    }
  }
}
