// Effective sender resolution, including wrapped forwards.

import { normalizeAddress, parseSender } from "./address";
import type { Sender } from "./types";

export const DEFAULT_FORWARD_LABELS: readonly string[] = ["From:", "Od:", "Nadawca:"];

/** How many characters of the body are searched for a forwarded-header label. */
export const FORWARD_BODY_LIMIT = 20000;
/**
 * The longest line RFC 5322 allows. A line is cut to it before it is searched, which
 * keeps the address patterns fast on one long line written by a sender.
 */
export const FORWARD_LINE_LIMIT = 998;

export type SenderSource = "from" | "x-original-from" | "x-original-sender" | "attachment" | "body" | "none";

export interface EffectiveSender {
  /** The sender trust decisions are made about. Null when it could not be determined. */
  sender: Sender | null;
  /** Normalized address of the forwarding mailbox for a wrapped forward, otherwise null. */
  forwarder: string | null;
  source: SenderSource;
}

/** Lazy access to the parts of a message that only wrapped forwards need. */
export interface ForwardSources {
  /** First address of a mailbox header value, or null. */
  parseAddress(raw: string): Promise<string | null>;
  /** All headers, keyed by lowercase name. */
  headers(): Promise<Record<string, string[]>>;
  /** Raw From value of the first attached message (message/rfc822), or null. */
  attachedMessageFrom(): Promise<string | null>;
  /** Plain-text body. */
  bodyText(): Promise<string>;
}

/**
 * The effective sender is the address in From, except when From is a forwarding
 * mailbox. Then it is the first of: X-Original-From, X-Original-Sender, the address
 * on the first body line that starts with a forwarded-header label, the From of the
 * first attached message. The forwarding mailbox itself is never the effective sender.
 *
 * The body line comes before the attachment because the forwarding mailbox writes it,
 * while an attached message is whatever the original sender attached: an inline
 * forward carries those attachments along, so an attached message from a trusted
 * address must not decide whom the forward is from.
 */
export async function resolveEffectiveSender(
  rawFrom: string,
  forwardingMailboxes: ReadonlySet<string>,
  labels: readonly string[],
  sources: ForwardSources,
): Promise<EffectiveSender> {
  const fromAddress = await safely(() => sources.parseAddress(rawFrom));
  const from = fromAddress === null ? null : parseSender(fromAddress);
  if (from === null) {
    return { sender: null, forwarder: null, source: "from" };
  }
  if (!forwardingMailboxes.has(from.address)) {
    return { sender: from, forwarder: null, source: "from" };
  }

  const accept = (raw: string | null): Sender | null => {
    if (raw === null) {
      return null;
    }
    const sender = parseSender(raw);
    return sender !== null && !forwardingMailboxes.has(sender.address) ? sender : null;
  };

  const headers = (await safely(() => sources.headers())) ?? {};
  for (const name of ["x-original-from", "x-original-sender"] as const) {
    for (const value of headers[name] ?? []) {
      const sender = accept(await safely(() => sources.parseAddress(value)));
      if (sender !== null) {
        return { sender, forwarder: from.address, source: name };
      }
    }
  }

  const body = await safely(() => sources.bodyText());
  if (body !== null) {
    const sender = accept(extractForwardedFrom(body, labels));
    if (sender !== null) {
      return { sender, forwarder: from.address, source: "body" };
    }
  }

  const attachedFrom = await safely(() => sources.attachedMessageFrom());
  if (attachedFrom !== null) {
    const sender = accept(await safely(() => sources.parseAddress(attachedFrom)));
    if (sender !== null) {
      return { sender, forwarder: from.address, source: "attachment" };
    }
  }

  return { sender: null, forwarder: from.address, source: "none" };
}

async function safely<T>(read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/**
 * Returns the address on the first line of a plain-text body that starts with a
 * forwarded-header label, or null. Only that first labelled line is considered.
 */
export function extractForwardedFrom(body: string, labels: readonly string[]): string | null {
  const wanted = labels.map(normalizeLabel).filter((label) => label !== "");
  if (wanted.length === 0) {
    return null;
  }
  for (const rawLine of body.slice(0, FORWARD_BODY_LIMIT).split(/\r?\n/)) {
    // Quote markers and the emphasis marks that HTML to text conversion leaves around bold labels.
    const line = rawLine.slice(0, FORWARD_LINE_LIMIT).replace(/^[\s>*_]+/, "");
    const lower = line.toLowerCase();
    for (const label of wanted) {
      if (!lower.startsWith(label)) {
        continue;
      }
      const rest = line.slice(label.length).replace(/^[*_]*\s*:/, "");
      if (rest === line.slice(label.length)) {
        continue; // the label is not followed by a colon, for example "Fromage"
      }
      return addressInText(rest);
    }
  }
  return null;
}

/** Label without its colon, lowercased: "From:" becomes "from". */
function normalizeLabel(label: string): string {
  return label.trim().replace(/:$/, "").trim().toLowerCase();
}

function addressInText(text: string): string | null {
  const candidates = [
    /<\s*([^<>\s]+@[^<>\s]+)\s*>/, // Name <address>
    /\[mailto:\s*([^\]\s]+@[^\]\s]+)\s*\]/i, // Name [mailto:address]
    /([^\s<>()[\],;:"]+@[^\s<>()[\],;:"]+)/, // bare address
  ];
  for (const pattern of candidates) {
    const match = pattern.exec(text);
    if (match?.[1] !== undefined) {
      const address = normalizeAddress(match[1].replace(/^mailto:/i, "").replace(/[.*_]+$/, ""));
      if (address !== null) {
        return address;
      }
    }
  }
  return null;
}
