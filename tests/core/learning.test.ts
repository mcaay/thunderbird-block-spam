import { describe, expect, it } from "vitest";
import { buildPublicDomains } from "../../src/core/address";
import { learnRecipient, learnRecipients, syncIdentities } from "../../src/core/learning";
import type { LearnContext } from "../../src/core/learning";
import { addEntry, entryKey } from "../../src/core/lists";
import type { EntryMap, NewEntry } from "../../src/core/lists";

const publicDomains = buildPublicDomains(["gmail.com", "wp.pl"], [], []);

function context(entries: EntryMap, partial: Partial<LearnContext> = {}): LearnContext {
  return {
    entries,
    publicDomains,
    ownAddresses: new Set(["me@mycompany.example"]),
    accountId: "account1",
    scope: "all",
    source: "sent",
    now: 50,
    ...partial,
  };
}

function black(map: EntryMap, partial: Partial<NewEntry>): void {
  addEntry(map, { list: "black", kind: "address", value: "x@example.com", scope: "all", source: "manual", ...partial }, 1);
}

describe("learning from recipients", () => {
  it("whitelists the domain of a custom domain recipient", () => {
    const entries: EntryMap = new Map();
    expect(learnRecipient(context(entries), "Jan.Kowalski@Sales.Example.com")).toBe("added");
    expect(entries.get(entryKey("domain", "example.com", "all"))).toMatchObject({
      list: "white",
      source: "sent",
      addedAt: 50,
    });
  });

  it("whitelists the address of a public domain recipient", () => {
    const entries: EntryMap = new Map();
    expect(learnRecipient(context(entries), "someone@gmail.com")).toBe("added");
    expect(entries.get(entryKey("address", "someone@gmail.com", "all"))?.list).toBe("white");
    expect(entries.has(entryKey("domain", "gmail.com", "all"))).toBe(false);
  });

  it("skips the user's own addresses", () => {
    const entries: EntryMap = new Map();
    expect(learnRecipient(context(entries), "Me@MyCompany.example")).toBe("own");
    expect(entries.size).toBe(0);
  });

  it("ignores what is not an address", () => {
    const entries: EntryMap = new Map();
    expect(learnRecipient(context(entries), "undisclosed-recipients")).toBe("invalid");
    expect(entries.size).toBe(0);
  });

  it("uses the account as scope when new entries are per account", () => {
    const entries: EntryMap = new Map();
    learnRecipient(context(entries, { scope: "account1" }), "a@example.com");
    expect(entries.has(entryKey("domain", "example.com", "account1"))).toBe(true);
  });

  it("records the scan source", () => {
    const entries: EntryMap = new Map();
    learnRecipient(context(entries, { source: "scan" }), "a@example.com");
    expect([...entries.values()][0]?.source).toBe("scan");
  });

  it("reports known recipients without changing them", () => {
    const entries: EntryMap = new Map();
    learnRecipient(context(entries, { now: 1 }), "a@example.com");
    expect(learnRecipient(context(entries, { now: 2 }), "b@example.com")).toBe("known");
    expect([...entries.values()][0]?.addedAt).toBe(1);
  });

  it("counts changed entries for a list of recipients", () => {
    const entries: EntryMap = new Map();
    const summary = learnRecipients(context(entries), [
      "a@example.com",
      "b@example.com",
      "c@gmail.com",
      "me@mycompany.example",
      "nonsense",
    ]);
    expect(summary.changed).toBe(2);
    expect(entries.size).toBe(2);
  });
});

describe("black list conflicts", () => {
  it("rule 1: a manual block of the address stops learning", () => {
    const entries: EntryMap = new Map();
    black(entries, { kind: "address", value: "x@example.com" });
    expect(learnRecipient(context(entries), "x@example.com")).toBe("manual-block");
    expect(entries.size).toBe(1);
    expect(entries.has(entryKey("domain", "example.com", "all"))).toBe(false);
  });

  it("rule 1: a manual block of the domain stops learning and adds no exception", () => {
    const entries: EntryMap = new Map();
    black(entries, { kind: "domain", value: "example.com" });
    expect(learnRecipient(context(entries), "john@mail.example.com")).toBe("manual-block");
    expect(entries.size).toBe(1);
    expect([...entries.values()][0]).toMatchObject({ list: "black", source: "manual" });
  });

  it("rule 1: a manual block of a public domain stops learning an address there", () => {
    const entries: EntryMap = new Map();
    black(entries, { kind: "domain", value: "gmail.com" });
    expect(learnRecipient(context(entries), "someone@gmail.com")).toBe("manual-block");
    expect(entries.size).toBe(1);
  });

  it("rule 1: a manual block scoped to the account of the sent message counts", () => {
    const entries: EntryMap = new Map();
    black(entries, { kind: "domain", value: "example.com", scope: "account1" });
    expect(learnRecipient(context(entries), "x@example.com")).toBe("manual-block");
  });

  it("rule 1: a manual block scoped to another account does not count", () => {
    const entries: EntryMap = new Map();
    black(entries, { kind: "domain", value: "example.com", scope: "account2" });
    expect(learnRecipient(context(entries), "x@example.com")).toBe("added");
    expect(entries.get(entryKey("domain", "example.com", "all"))?.list).toBe("white");
    expect(entries.get(entryKey("domain", "example.com", "account2"))?.list).toBe("black");
  });

  it("a manual block of another address in the domain does not stop learning the domain", () => {
    const entries: EntryMap = new Map();
    black(entries, { kind: "address", value: "newsletter@example.com" });
    expect(learnRecipient(context(entries), "john@example.com")).toBe("added");
    expect(entries.get(entryKey("domain", "example.com", "all"))?.list).toBe("white");
    expect(entries.get(entryKey("address", "newsletter@example.com", "all"))?.list).toBe("black");
  });

  it("rule 2: an AI block with the same key is replaced", () => {
    const entries: EntryMap = new Map();
    black(entries, { kind: "domain", value: "example.com", source: "ai" });
    expect(learnRecipient(context(entries), "john@example.com")).toBe("replaced");
    expect(entries.size).toBe(1);
    expect(entries.get(entryKey("domain", "example.com", "all"))).toMatchObject({ list: "white", source: "sent" });
  });

  it("rule 2: an AI block of the address is replaced for a public domain", () => {
    const entries: EntryMap = new Map();
    black(entries, { kind: "address", value: "someone@gmail.com", source: "ai" });
    expect(learnRecipient(context(entries), "someone@gmail.com")).toBe("replaced");
    expect(entries.get(entryKey("address", "someone@gmail.com", "all"))?.list).toBe("white");
  });

  it("rule 2: an AI block with a different key stays, and the white list entry is added", () => {
    const entries: EntryMap = new Map();
    black(entries, { kind: "address", value: "sales@example.com", source: "ai" });
    expect(learnRecipient(context(entries), "john@example.com")).toBe("added");
    expect(entries.get(entryKey("address", "sales@example.com", "all"))?.list).toBe("black");
    expect(entries.get(entryKey("domain", "example.com", "all"))?.list).toBe("white");
  });

  it("rule 2: an AI block with another key that still decides the recipient is removed", () => {
    // From when example.com was a public domain: the AI blocked the address.
    const address: EntryMap = new Map();
    black(address, { kind: "address", value: "john@example.com", source: "ai" });
    expect(learnRecipient(context(address), "john@example.com")).toBe("added");
    expect([...address.values()]).toMatchObject([{ list: "white", kind: "domain", value: "example.com" }]);

    // From when new entries were per account: the AI blocked the domain in account1.
    const scoped: EntryMap = new Map();
    black(scoped, { kind: "domain", value: "example.com", scope: "account1", source: "ai" });
    expect(learnRecipient(context(scoped), "john@example.com")).toBe("added");
    expect(scoped.has(entryKey("domain", "example.com", "account1"))).toBe(false);

    // An entry that already existed counts as replaced when an AI block behind it goes.
    const known: EntryMap = new Map();
    addEntry(known, { list: "white", kind: "domain", value: "example.com", scope: "all", source: "scan" }, 1);
    black(known, { kind: "domain", value: "example.com", scope: "account1", source: "ai" });
    expect(learnRecipient(context(known), "john@example.com")).toBe("replaced");
    expect(known.size).toBe(1);
  });
});

describe("identities", () => {
  it("adds own addresses as smart targets with scope all", () => {
    const entries: EntryMap = new Map();
    expect(syncIdentities(entries, ["Me@MyCompany.example", "private@gmail.com"], publicDomains, 7)).toBe(2);
    expect(entries.get(entryKey("domain", "mycompany.example", "all"))).toMatchObject({
      list: "white",
      source: "identity",
      addedAt: 7,
    });
    expect(entries.get(entryKey("address", "private@gmail.com", "all"))?.source).toBe("identity");
  });

  it("adds nothing when an entry with that key exists in either list", () => {
    const entries: EntryMap = new Map();
    black(entries, { kind: "domain", value: "mycompany.example" });
    addEntry(entries, { list: "white", kind: "address", value: "private@gmail.com", scope: "all", source: "sent" }, 1);
    expect(syncIdentities(entries, ["me@mycompany.example", "private@gmail.com"], publicDomains, 7)).toBe(0);
    expect(entries.get(entryKey("domain", "mycompany.example", "all"))?.list).toBe("black");
    expect(entries.get(entryKey("address", "private@gmail.com", "all"))?.source).toBe("sent");
  });

  it("adds the entry again after the user removed it", () => {
    const entries: EntryMap = new Map();
    syncIdentities(entries, ["me@mycompany.example"], publicDomains, 1);
    entries.clear();
    expect(syncIdentities(entries, ["me@mycompany.example"], publicDomains, 2)).toBe(1);
  });
});
