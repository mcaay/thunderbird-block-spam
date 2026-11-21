// Address normalization, registrable domains, public domains and the smart target.

import { getDomain } from "tldts";
import type { Sender, Target } from "./types";

const HOST_FORBIDDEN = /[\s/\\:?#@[\]%<>"',;()]/;
const LOCAL_FORBIDDEN = /[\s<>]/;
const LABEL = "[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?";
const ASCII_HOST = new RegExp(`^(?=.{1,253}$)${LABEL}(\\.${LABEL})*$`);
const ASCII_ONLY = /^[\x21-\x7e]+$/;

/** Converts a domain to its lowercase ASCII (punycode) form. Returns null when it is not a valid host. */
export function domainToAscii(domain: string): string | null {
  let host = domain.trim().toLowerCase();
  if (host.endsWith(".")) {
    host = host.slice(0, -1);
  }
  if (host === "") {
    return null;
  }
  if (isIpLiteral(host)) {
    return host;
  }
  if (HOST_FORBIDDEN.test(host)) {
    return null;
  }
  if (ASCII_ONLY.test(host)) {
    return ASCII_HOST.test(host) ? host : null;
  }
  // Internationalized domain: the URL parser applies IDNA and returns punycode.
  try {
    const ascii = new URL(`http://${host}/`).hostname;
    return ASCII_HOST.test(ascii) ? ascii : null;
  } catch {
    return null;
  }
}

/** An address literal such as [192.0.2.1] or [IPv6:2001:db8::1], or a bare IPv4 address. */
export function isIpLiteral(host: string): boolean {
  return /^\[[0-9a-z:.]+\]$/i.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Normalizes one address (an addr-spec, as produced by the mailbox parser): trimmed,
 * lowercased, with the domain in ASCII. Returns null when it cannot be an address.
 */
export function normalizeAddress(raw: string): string | null {
  const text = raw.trim();
  const at = text.lastIndexOf("@");
  if (at <= 0 || at === text.length - 1) {
    return null;
  }
  const local = text.slice(0, at).toLowerCase();
  if (LOCAL_FORBIDDEN.test(local)) {
    return null;
  }
  const host = domainToAscii(text.slice(at + 1));
  if (host === null) {
    return null;
  }
  return `${local}@${host}`;
}

/** Registrable domain from the Public Suffix List. Hosts without one are used as they are. */
export function registrableDomain(host: string): string {
  if (isIpLiteral(host)) {
    return host;
  }
  return getDomain(host, { allowPrivateDomains: true, extractHostname: false }) ?? host;
}

/** Normalizes a domain typed by the user or stored in settings. Returns null when invalid. */
export function normalizeDomain(raw: string): string | null {
  const text = raw.trim().replace(/^@/, "");
  return domainToAscii(text);
}

/** RFC 5321 allows no longer address. */
export const MAX_ADDRESS_LENGTH = 254;

/**
 * A sender or recipient from mail. Longer addresses than RFC 5321 allows are refused,
 * so that a message cannot put an arbitrarily long value into the log or the lists;
 * stored entries are checked with normalizeAddress and keep loading.
 */
export function parseSender(rawAddress: string): Sender | null {
  const address = normalizeAddress(rawAddress);
  if (address === null || address.length > MAX_ADDRESS_LENGTH) {
    return null;
  }
  const host = address.slice(address.lastIndexOf("@") + 1);
  return { address, host, domain: registrableDomain(host) };
}

/** Effective public domain list: bundled plus added, minus removed. */
export function buildPublicDomains(
  bundled: readonly string[],
  added: readonly string[],
  removed: readonly string[],
): Set<string> {
  const set = new Set<string>(bundled);
  for (const domain of added) {
    set.add(domain);
  }
  for (const domain of removed) {
    set.delete(domain);
  }
  return set;
}

/** A sender is public when its host or its registrable domain is on the list. */
export function isPublic(sender: Sender, publicDomains: ReadonlySet<string>): boolean {
  return publicDomains.has(sender.host) || publicDomains.has(sender.domain);
}

/** The address itself when its domain is public, otherwise its registrable domain. */
export function smartTarget(sender: Sender, publicDomains: ReadonlySet<string>): Target {
  return isPublic(sender, publicDomains)
    ? { kind: "address", value: sender.address }
    : { kind: "domain", value: sender.domain };
}
