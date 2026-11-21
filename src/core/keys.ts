// Storage keys. Kept free of other imports so that small pages can read storage
// without pulling in the rest of the core.

export const KEY_SETTINGS = "settings";
export const KEY_ENTRIES = "entries";
export const KEY_ACCESS_POINTS = "accessPoints";
export const KEY_META = "meta";
export const KEY_LOG_META = "logMeta";
export const PREFIX_PROCESSED_IN = "processed:in:";
export const PREFIX_PROCESSED_SENT = "processed:sent:";
export const PREFIX_LOG = "log:";

export interface LogMeta {
  /** Index of the oldest chunk. */
  first: number;
  /** Index of the newest chunk. */
  last: number;
}

export const EMPTY_LOG_META: LogMeta = { first: 0, last: 0 };

export function logChunkKey(index: number): string {
  return `${PREFIX_LOG}${index}`;
}
