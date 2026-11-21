// The decision log: stored in chunks and capped at 5000 entries. Message bodies are never stored.

import { ValidationError } from "./settings";
import type { LogEntry } from "./types";

export const LOG_CHUNK_SIZE = 250;
export const LOG_MAX_ENTRIES = 5000;
export const LOG_MAX_CHUNKS = LOG_MAX_ENTRIES / LOG_CHUNK_SIZE;
export const LOG_SUBJECT_LIMIT = 200;
export const LOG_DETAIL_LIMIT = 300;

export interface LogMeta {
  /** Index of the oldest chunk. */
  first: number;
  /** Index of the newest chunk. */
  last: number;
}

export function logChunkKey(index: number): string {
  return `log:${index}`;
}

export const EMPTY_LOG_META: LogMeta = { first: 0, last: 0 };

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

export function validateLogMeta(value: unknown): LogMeta {
  if (
    typeof value === "object" &&
    value !== null &&
    Number.isInteger((value as LogMeta).first) &&
    Number.isInteger((value as LogMeta).last) &&
    (value as LogMeta).first >= 0 &&
    (value as LogMeta).last >= (value as LogMeta).first
  ) {
    return { first: (value as LogMeta).first, last: (value as LogMeta).last };
  }
  throw new ValidationError("logMeta: expected first and last chunk numbers");
}
