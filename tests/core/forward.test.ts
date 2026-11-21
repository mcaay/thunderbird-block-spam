import { describe, expect, it } from "vitest";
import { DEFAULT_FORWARD_LABELS, extractForwardedFrom, FORWARD_LINE_LIMIT, resolveEffectiveSender } from "../../src/core/forward";
import type { ForwardSources } from "../../src/core/forward";
import { fakeParseAddresses } from "../helpers/fakes";

const FORWARDERS = new Set(["office@partner.example"]);

interface Parts {
  headers?: Record<string, string[]>;
  attached?: string | null;
  body?: string;
  failHeaders?: boolean;
}

function sources(parts: Parts = {}): ForwardSources & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    parseAddress: async (raw) => fakeParseAddresses(raw)[0] ?? null,
    headers: async () => {
      calls.push("headers");
      if (parts.failHeaders) {
        throw new Error("offline");
      }
      return parts.headers ?? {};
    },
    attachedMessageFrom: async () => {
      calls.push("attachment");
      return parts.attached ?? null;
    },
    bodyText: async () => {
      calls.push("body");
      return parts.body ?? "";
    },
  };
}

function resolve(from: string, parts: Parts = {}, labels: readonly string[] = DEFAULT_FORWARD_LABELS) {
  const source = sources(parts);
  return resolveEffectiveSender(from, FORWARDERS, labels, source).then((result) => ({ result, calls: source.calls }));
}

describe("effective sender", () => {
  it("is the From address for ordinary mail, without reading anything else", async () => {
    const { result, calls } = await resolve("John Doe <John@Example.com>");
    expect(result).toEqual({
      sender: { address: "john@example.com", host: "example.com", domain: "example.com" },
      forwarder: null,
      source: "from",
    });
    expect(calls).toEqual([]);
  });

  it("is unknown when From cannot be parsed", async () => {
    expect((await resolve("undisclosed")).result).toEqual({ sender: null, forwarder: null, source: "from" });
  });

  it("uses X-Original-From for a forwarding mailbox", async () => {
    const { result, calls } = await resolve("Office <office@partner.example>", {
      headers: { "x-original-from": ["Spammer <cold@outreach.example>"], "x-original-sender": ["other@x.example"] },
    });
    expect(result.sender?.address).toBe("cold@outreach.example");
    expect(result.forwarder).toBe("office@partner.example");
    expect(result.source).toBe("x-original-from");
    expect(calls).toEqual(["headers"]);
  });

  it("falls back to X-Original-Sender", async () => {
    const { result } = await resolve("office@partner.example", {
      headers: { "x-original-sender": ["cold@outreach.example"] },
    });
    expect(result).toMatchObject({ source: "x-original-sender", forwarder: "office@partner.example" });
    expect(result.sender?.address).toBe("cold@outreach.example");
  });

  it("uses the From of the first attached message", async () => {
    const { result, calls } = await resolve("office@partner.example", {
      attached: "Cold Sender <cold@outreach.example>",
      body: "From: wrong@body.example",
    });
    expect(result).toMatchObject({ source: "attachment" });
    expect(result.sender?.address).toBe("cold@outreach.example");
    expect(calls).toEqual(["headers", "attachment"]);
  });

  it("uses the first labelled line of the body", async () => {
    const body = ["Hello,", "", "-----Original Message-----", "From: Cold Sender <cold@outreach.example>", "Sent: Monday", "From: second@later.example"].join("\n");
    const { result, calls } = await resolve("office@partner.example", { body });
    expect(result).toMatchObject({ source: "body", forwarder: "office@partner.example" });
    expect(result.sender?.address).toBe("cold@outreach.example");
    expect(calls).toEqual(["headers", "attachment", "body"]);
  });

  it("treats the sender as unknown when nothing is found", async () => {
    const { result } = await resolve("office@partner.example", { body: "No forwarded header here." });
    expect(result).toEqual({ sender: null, forwarder: "office@partner.example", source: "none" });
  });

  it("never returns a forwarding mailbox as the effective sender", async () => {
    const { result } = await resolve("office@partner.example", {
      headers: { "x-original-from": ["office@partner.example"] },
      attached: "Office <office@partner.example>",
      body: "From: office@partner.example",
    });
    expect(result).toEqual({ sender: null, forwarder: "office@partner.example", source: "none" });
  });

  it("continues with the next source when one cannot be read", async () => {
    const { result } = await resolve("office@partner.example", {
      failHeaders: true,
      attached: "cold@outreach.example",
    });
    expect(result.source).toBe("attachment");
  });

  it("matches the forwarding mailbox case-insensitively", async () => {
    const { result } = await resolve("OFFICE@Partner.Example", { headers: { "x-original-from": ["a@b.example"] } });
    expect(result.forwarder).toBe("office@partner.example");
  });
});

describe("extractForwardedFrom", () => {
  const labels = DEFAULT_FORWARD_LABELS;

  it("reads the address after each default label", () => {
    expect(extractForwardedFrom("From: John Doe <john@example.com>", labels)).toBe("john@example.com");
    expect(extractForwardedFrom("Od: Jan Kowalski <jan@firma.example>", labels)).toBe("jan@firma.example");
    expect(extractForwardedFrom("Nadawca: jan@firma.example", labels)).toBe("jan@firma.example");
  });

  it("is case-insensitive and tolerates quoting and emphasis marks", () => {
    expect(extractForwardedFrom("> from: a@b.example", labels)).toBe("a@b.example");
    expect(extractForwardedFrom("*From:* John <a@b.example>", labels)).toBe("a@b.example");
    expect(extractForwardedFrom("**Od**: Jan <a@b.example>", labels)).toBe("a@b.example");
    expect(extractForwardedFrom("   FROM : a@b.example", labels)).toBe("a@b.example");
  });

  it("understands the Outlook mailto form", () => {
    expect(extractForwardedFrom("From: John Doe [mailto:John@Example.com]", labels)).toBe("john@example.com");
    expect(extractForwardedFrom("From: John <mailto:john@example.com>", labels)).toBe("john@example.com");
  });

  it("considers only the first labelled line", () => {
    expect(extractForwardedFrom("From: John Doe\nFrom: real@example.com", labels)).toBeNull();
  });

  it("ignores lines where the label is only a prefix of a word", () => {
    expect(extractForwardedFrom("Fromage: a@b.example\nOdpowiedz: c@d.example", labels)).toBeNull();
    expect(extractForwardedFrom("Text before From: a@b.example", labels)).toBeNull();
  });

  it("supports extended labels", () => {
    expect(extractForwardedFrom("Von: Hans <hans@firma.example>", [...labels, "Von:"])).toBe("hans@firma.example");
    expect(extractForwardedFrom("Von: Hans <hans@firma.example>", labels)).toBeNull();
    expect(extractForwardedFrom("De : jean@exemple.example", ["De"])).toBe("jean@exemple.example");
  });

  it("returns null without labels or for an empty body", () => {
    expect(extractForwardedFrom("From: a@b.example", [])).toBeNull();
    expect(extractForwardedFrom("", labels)).toBeNull();
  });

  it("searches only the first 998 characters of a labelled line, so one long line stays fast", () => {
    const padded = `From: ${" ".repeat(FORWARD_LINE_LIMIT)}cold@outreach.example`;
    expect(extractForwardedFrom(padded, DEFAULT_FORWARD_LABELS)).toBeNull();
    expect(extractForwardedFrom(`From: ${" ".repeat(900)}cold@outreach.example`, DEFAULT_FORWARD_LABELS)).toBe("cold@outreach.example");
    const started = performance.now();
    for (const filler of ["a", ".", "<a", "[mailto:a"]) {
      expect(extractForwardedFrom(`From: ${filler.repeat(19990 / filler.length)}`, DEFAULT_FORWARD_LABELS)).toBeNull();
    }
    // Each of these lines took about 190 ms before lines were cut.
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("handles Windows line endings", () => {
    expect(extractForwardedFrom("Hi\r\nFrom: a@b.example\r\nTo: me", labels)).toBe("a@b.example");
  });
});
