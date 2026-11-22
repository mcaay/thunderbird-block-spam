// Storage keys. Kept free of other imports so that small pages can read storage
// without pulling in the rest of the core.

export const KEY_SETTINGS = "settings";
export const KEY_ENTRIES = "entries";
export const KEY_ACCESS_POINTS = "accessPoints";
export const KEY_META = "meta";
export const KEY_LOG_META = "logMeta";
/** The last block or trust command made by hand, with what is needed to take it back. */
export const KEY_LAST_COMMAND = "lastCommand";
/** The AI services the user was already told about that they need attention. */
export const KEY_ATTENTION_NOTIFIED = "attentionNotified";
/** "Switch protection on" that waits for the scan of the sent mail, and what became of it. See core/protectionWish. */
export const KEY_PROTECTION_WISH = "protectionWish";
/** The last merge of an import, with what is needed to take it back. */
export const KEY_LAST_IMPORT = "lastImport";
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

/**
 * Names one entry of the log, so that the popup can ask the settings page to show it.
 * Entries have no number of their own; the moment, the message and the kind of entry
 * tell them apart.
 */
export function logEntryKey(entry: {
  time: number;
  accountId: string;
  sender: string;
  outcome: string;
  test: boolean;
  messageId?: string;
}): string {
  return [entry.time, entry.accountId, entry.messageId ?? "", entry.sender, entry.outcome, entry.test ? "test" : ""].join("|");
}
