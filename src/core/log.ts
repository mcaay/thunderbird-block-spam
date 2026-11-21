// The decision log: stored in chunks and capped at 5000 entries. Message bodies are never stored.

import type { LogMeta } from "./keys";
import { asBoolean, asNumber, asOneOf, asRecord, asString, ValidationError } from "./settings";
import type { Action, LogEntry, Outcome } from "./types";

/** Each logged decision rewrites the newest chunk, so chunks are kept small. */
export const LOG_CHUNK_SIZE = 50;
export const LOG_MAX_ENTRIES = 5000;
export const LOG_MAX_CHUNKS = LOG_MAX_ENTRIES / LOG_CHUNK_SIZE;
export const LOG_SUBJECT_LIMIT = 200;
export const LOG_DETAIL_LIMIT = 300;
/** A longer Message-ID is not stored: it could not be looked up when cut. */
export const LOG_MESSAGE_ID_LIMIT = 300;

export { EMPTY_LOG_META, logChunkKey } from "./keys";
export type { LogMeta } from "./keys";

export interface LogWrite {
  meta: LogMeta;
  chunkIndex: number;
  chunk: LogEntry[];
  removeChunks: number[];
}

/**
 * Appends one entry. Takes the current meta and the newest chunk, returns what to
 * store. When the newest chunk is full a new one is started, and chunks beyond the
 * cap are dropped from the old end.
 */
export function appendLog(meta: LogMeta, lastChunk: readonly LogEntry[], entry: LogEntry): LogWrite {
  const trimmed: LogEntry = {
    ...entry,
    subject: entry.subject.slice(0, LOG_SUBJECT_LIMIT),
    detail: entry.detail.slice(0, LOG_DETAIL_LIMIT),
    messageId: entry.messageId.length > LOG_MESSAGE_ID_LIMIT ? "" : entry.messageId,
  };
  if (lastChunk.length < LOG_CHUNK_SIZE) {
    return { meta, chunkIndex: meta.last, chunk: [...lastChunk, trimmed], removeChunks: [] };
  }
  const last = meta.last + 1;
  const removeChunks: number[] = [];
  let first = meta.first;
  while (last - first + 1 > LOG_MAX_CHUNKS) {
    removeChunks.push(first);
    first += 1;
  }
  return { meta: { first, last }, chunkIndex: last, chunk: [trimmed], removeChunks };
}

/** At most as many chunks as the cap keeps, so that nothing loops over an unbounded range. */
export function validateLogMeta(value: unknown): LogMeta {
  if (
    typeof value === "object" &&
    value !== null &&
    Number.isSafeInteger((value as LogMeta).first) &&
    Number.isSafeInteger((value as LogMeta).last) &&
    (value as LogMeta).first >= 0 &&
    (value as LogMeta).last >= (value as LogMeta).first &&
    (value as LogMeta).last - (value as LogMeta).first < LOG_MAX_CHUNKS
  ) {
    return { first: (value as LogMeta).first, last: (value as LogMeta).last };
  }
  throw new ValidationError("logMeta: expected first and last chunk numbers");
}

const OUTCOMES: readonly Outcome[] = ["trusted", "blocked", "spam", "passed", "no-verdict", "released", "error"];
const ACTIONS: readonly Action[] = ["none", "junk", "screening", "inbox"];

export function validateLogEntry(value: unknown, path: string): LogEntry {
  const record = asRecord(value, path);
  return {
    time: asNumber(record.time, `${path}.time`),
    accountId: asString(record.accountId, `${path}.accountId`),
    account: asString(record.account, `${path}.account`),
    sender: asString(record.sender, `${path}.sender`),
    via: asString(record.via, `${path}.via`),
    subject: asString(record.subject, `${path}.subject`),
    outcome: asOneOf(record.outcome, OUTCOMES, `${path}.outcome`),
    action: asOneOf(record.action, ACTIONS, `${path}.action`),
    score: record.score === null ? null : asNumber(record.score, `${path}.score`),
    accessPoint: asString(record.accessPoint, `${path}.accessPoint`),
    reason: asString(record.reason, `${path}.reason`),
    detail: asString(record.detail, `${path}.detail`),
    observed: asBoolean(record.observed, `${path}.observed`),
    test: asBoolean(record.test, `${path}.test`),
    // Entries logged before the field existed have none. They load with an empty value.
    messageId: record.messageId === undefined ? "" : asString(record.messageId, `${path}.messageId`),
  };
}
