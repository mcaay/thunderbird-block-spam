import { describe, expect, it } from "vitest";
import {
  buildPublicDomains,
  domainToAscii,
  isPublic,
  normalizeAddress,
  normalizeDomain,
  parseSender,
  registrableDomain,
  smartTarget,
} from "../../src/core/address";
import { BUNDLED_PUBLIC_DOMAINS } from "../../src/data/publicDomains";

const APPENDIX_A =
  "gmail.com, googlemail.com, outlook.com, hotmail.com, live.com, msn.com, yahoo.com, ymail.com, icloud.com, me.com, mac.com, aol.com, proton.me, protonmail.com, pm.me, gmx.com, gmx.net, gmx.de, web.de, mail.com, zoho.com, yandex.com, yandex.ru, mail.ru, fastmail.com, tuta.com, tutanota.com, hey.com, wp.pl, o2.pl, onet.pl, onet.eu, op.pl, poczta.onet.pl, vp.pl, interia.pl, interia.eu, poczta.fm, gazeta.pl, tlen.pl, go2.pl, int.pl".split(
    ", ",
  );

const publicDomains = buildPublicDomains(BUNDLED_PUBLIC_DOMAINS, [], []);

describe("normalizeAddress", () => {
  it("trims and lowercases", () => {
    expect(normalizeAddress("  John.Doe@Example.COM ")).toBe("john.doe@example.com");
  });

  it("converts the domain to punycode", () => {
    expect(normalizeAddress("jan@żółw.pl")).toBe("jan@xn--w-uga1v8h.pl");
    expect(normalizeAddress("user@пример.рф")).toBe("user@xn--e1afmkfd.xn--p1ai");
  });

  it("keeps an existing punycode domain", () => {
    expect(normalizeAddress("jan@xn--w-uga1v8h.pl")).toBe("jan@xn--w-uga1v8h.pl");
  });

  it("uses the last @ as the separator", () => {
    expect(normalizeAddress('"odd@local"@example.com')).toBe('"odd@local"@example.com');
  });

  it("removes one trailing dot of the domain", () => {
    expect(normalizeAddress("a@example.com.")).toBe("a@example.com");
  });

  it("rejects what is not an address", () => {
    for (const bad of ["", "plain", "@example.com", "user@", "a b@example.com", "user@exa mple.com", "user@host:25", "user@-bad-.com", "user@a..b"]) {
      expect(normalizeAddress(bad), bad).toBeNull();
    }
  });

  it("accepts address literals", () => {
    expect(normalizeAddress("root@[192.168.1.10]")).toBe("root@[192.168.1.10]");
  });
});

describe("domainToAscii and normalizeDomain", () => {
  it("normalizes domains typed by the user", () => {
    expect(normalizeDomain(" Example.COM ")).toBe("example.com");
    expect(normalizeDomain("@example.com")).toBe("example.com");
    expect(normalizeDomain("żółw.pl")).toBe("xn--w-uga1v8h.pl");
  });

  it("rejects invalid domains", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("exa mple.com")).toBeNull();
    expect(normalizeDomain("http://example.com")).toBeNull();
    expect(domainToAscii("a/b")).toBeNull();
  });

  it("does not turn numeric labels into IP addresses", () => {
    expect(domainToAscii("1234")).toBe("1234");
    expect(domainToAscii("123.com")).toBe("123.com");
  });
});

describe("registrableDomain", () => {
  it("uses the Public Suffix List", () => {
    expect(registrableDomain("mail.sales.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("example.com")).toBe("example.com");
    expect(registrableDomain("a.b.example.com.pl")).toBe("example.com.pl");
  });

  it("treats private suffixes as suffixes", () => {
    expect(registrableDomain("someone.github.io")).toBe("someone.github.io");
  });

  it("handles internationalized suffixes in punycode", () => {
    expect(registrableDomain("mail.example.xn--p1ai")).toBe("example.xn--p1ai");
  });

  it("uses hosts without a registrable domain as they are", () => {
    expect(registrableDomain("localhost")).toBe("localhost");
    expect(registrableDomain("192.168.1.1")).toBe("192.168.1.1");
    expect(registrableDomain("[192.168.1.1]")).toBe("[192.168.1.1]");
  });
});

describe("public domains", () => {
  it("contains at least the providers of appendix A", () => {
    const bundled = new Set(BUNDLED_PUBLIC_DOMAINS);
    expect(APPENDIX_A.filter((domain) => !bundled.has(domain))).toEqual([]);
  });

  it("holds only normalized, unique domains", () => {
    expect(new Set(BUNDLED_PUBLIC_DOMAINS).size).toBe(BUNDLED_PUBLIC_DOMAINS.length);
    expect(BUNDLED_PUBLIC_DOMAINS.filter((domain) => normalizeDomain(domain) !== domain)).toEqual([]);
  });

  it("applies the user's additions and removals", () => {
    const set = buildPublicDomains(["gmail.com", "wp.pl"], ["myisp.example"], ["wp.pl"]);
    expect([...set].sort()).toEqual(["gmail.com", "myisp.example"]);
  });

  it("is public when the host or the registrable domain is on the list", () => {
    const viaHost = parseSender("a@poczta.onet.pl");
    const viaDomain = parseSender("a@sub.gmail.com");
    const custom = parseSender("a@mail.betis.eu");
    expect(viaHost && isPublic(viaHost, publicDomains)).toBe(true);
    expect(viaDomain && isPublic(viaDomain, publicDomains)).toBe(true);
    expect(custom && isPublic(custom, publicDomains)).toBe(false);
  });
});

describe("smartTarget", () => {
  it("is the address for a public domain", () => {
    const sender = parseSender("Jan.Kowalski@gmail.com");
    expect(sender && smartTarget(sender, publicDomains)).toEqual({ kind: "address", value: "jan.kowalski@gmail.com" });
  });

  it("is the registrable domain for a custom domain", () => {
    const sender = parseSender("jan@mail.sales.example.co.uk");
    expect(sender && smartTarget(sender, publicDomains)).toEqual({ kind: "domain", value: "example.co.uk" });
  });

  it("follows the edited list without touching entries", () => {
    const sender = parseSender("jan@example.com");
    const edited = buildPublicDomains(BUNDLED_PUBLIC_DOMAINS, ["example.com"], ["gmail.com"]);
    const gmail = parseSender("x@gmail.com");
    expect(sender && smartTarget(sender, edited).kind).toBe("address");
    expect(gmail && smartTarget(gmail, edited)).toEqual({ kind: "domain", value: "gmail.com" });
  });
});
