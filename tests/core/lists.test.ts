import { describe, expect, it } from "vitest";
import { parseSender } from "../../src/core/address";
import { addEntry, entriesFromArray, entryKey, matchSender, removeEntry, whiteListIsOnlyIdentities } from "../../src/core/lists";
import type { EntryMap, NewEntry } from "../../src/core/lists";
import type { Sender } from "../../src/core/types";

function sender(address: string): Sender {
  const parsed = parseSender(address);
  if (parsed === null) {
    throw new Error(`bad test address ${address}`);
  }
  return parsed;
}

function entry(partial: Partial<NewEntry>): NewEntry {
  return { list: "white", kind: "address", value: "a@example.com", scope: "all", source: "manual", ...partial };
}

describe("entry uniqueness", () => {
  it("adds a new key", () => {
    const map: EntryMap = new Map();
    expect(addEntry(map, entry({}), 100)).toBe("added");
    expect(map.get(entryKey("address", "a@example.com", "all"))).toEqual({
      list: "white",
      kind: "address",
      value: "a@example.com",
      scope: "all",
      source: "manual",
      addedAt: 100,
    });
  });

  it("keeps a key at most once across both lists", () => {
    const map: EntryMap = new Map();
    addEntry(map, entry({ list: "white", source: "sent" }), 1);
    expect(addEntry(map, entry({ list: "black", source: "manual" }), 2)).toBe("moved");
    expect(map.size).toBe(1);
    expect([...map.values()][0]).toMatchObject({ list: "black", source: "manual", addedAt: 2 });
  });

  it("changes nothing when the key already exists in the same list", () => {
    const map: EntryMap = new Map();
    addEntry(map, entry({ source: "sent" }), 1);
    expect(addEntry(map, entry({ source: "scan" }), 2)).toBe("unchanged");
    expect([...map.values()][0]).toMatchObject({ source: "sent", addedAt: 1 });
  });

  it("sets the source to manual on a manual add of an existing key", () => {
    const map: EntryMap = new Map();
    addEntry(map, entry({ source: "sent" }), 1);
    expect(addEntry(map, entry({ source: "manual" }), 2)).toBe("source-updated");
    expect([...map.values()][0]).toMatchObject({ source: "manual", addedAt: 1 });
    expect(addEntry(map, entry({ source: "manual" }), 3)).toBe("unchanged");
  });

  it("treats kind, value and scope as the key", () => {
    const map: EntryMap = new Map();
    addEntry(map, entry({ scope: "all" }), 1);
    addEntry(map, entry({ scope: "account1" }), 1);
    addEntry(map, entry({ kind: "domain", value: "example.com" }), 1);
    expect(map.size).toBe(3);
    expect(removeEntry(map, entryKey("address", "a@example.com", "account1"))).toBe(true);
    expect(removeEntry(map, entryKey("address", "a@example.com", "account1"))).toBe(false);
    expect(map.size).toBe(2);
  });

  it("rebuilds the map from stored entries", () => {
    const map: EntryMap = new Map();
    addEntry(map, entry({}), 1);
    addEntry(map, entry({ kind: "domain", value: "example.com", list: "black" }), 2);
    expect(entriesFromArray([...map.values()])).toEqual(map);
  });
});

describe("matching", () => {
  const who = sender("newsletter@mail.example.co.uk");

  it("returns null for an unknown sender", () => {
    expect(matchSender(new Map(), who, "account1")).toBeNull();
  });

  it("matches the address and the registrable domain", () => {
    const byAddress: EntryMap = new Map();
    addEntry(byAddress, entry({ value: "newsletter@mail.example.co.uk" }), 1);
    expect(matchSender(byAddress, who, "account1")?.kind).toBe("address");

    const byDomain: EntryMap = new Map();
    addEntry(byDomain, entry({ kind: "domain", value: "example.co.uk", list: "black" }), 1);
    expect(matchSender(byDomain, who, "account1")).toMatchObject({ kind: "domain", list: "black" });
  });

  it("does not match the host when only the registrable domain differs", () => {
    const map: EntryMap = new Map();
    addEntry(map, entry({ kind: "domain", value: "mail.example.co.uk" }), 1);
    expect(matchSender(map, who, "account1")).toBeNull();
  });

  it("decides in the order address/account, address/all, domain/account, domain/all", () => {
    const map: EntryMap = new Map();
    addEntry(map, entry({ kind: "domain", value: "example.co.uk", scope: "all", list: "white" }), 1);
    expect(matchSender(map, who, "account1")).toMatchObject({ kind: "domain", scope: "all" });

    addEntry(map, entry({ kind: "domain", value: "example.co.uk", scope: "account1", list: "black" }), 2);
    expect(matchSender(map, who, "account1")).toMatchObject({ kind: "domain", scope: "account1", list: "black" });

    addEntry(map, entry({ value: who.address, scope: "all", list: "white" }), 3);
    expect(matchSender(map, who, "account1")).toMatchObject({ kind: "address", scope: "all", list: "white" });

    addEntry(map, entry({ value: who.address, scope: "account1", list: "black" }), 4);
    expect(matchSender(map, who, "account1")).toMatchObject({ kind: "address", scope: "account1", list: "black" });
  });

  it("ignores entries scoped to another account", () => {
    const map: EntryMap = new Map();
    addEntry(map, entry({ value: who.address, scope: "account2", list: "black" }), 1);
    expect(matchSender(map, who, "account1")).toBeNull();
    expect(matchSender(map, who, "account2")?.list).toBe("black");
  });

  it("lets a blocked address stay blocked inside a trusted domain", () => {
    const map: EntryMap = new Map();
    addEntry(map, entry({ kind: "domain", value: "example.co.uk", list: "white" }), 1);
    addEntry(map, entry({ value: who.address, list: "black" }), 2);
    expect(matchSender(map, who, "account1")?.list).toBe("black");
    expect(matchSender(map, sender("ceo@example.co.uk"), "account1")?.list).toBe("white");
  });

  it("lets a trusted person pass inside a blocked domain", () => {
    const map: EntryMap = new Map();
    addEntry(map, entry({ kind: "domain", value: "example.co.uk", list: "black" }), 1);
    addEntry(map, entry({ value: "friend@example.co.uk", list: "white" }), 2);
    expect(matchSender(map, sender("friend@example.co.uk"), "account1")?.list).toBe("white");
    expect(matchSender(map, who, "account1")?.list).toBe("black");
  });
});

describe("whiteListIsOnlyIdentities", () => {
  it("is true for an empty list and for identity entries only", () => {
    const map: EntryMap = new Map();
    expect(whiteListIsOnlyIdentities(map)).toBe(true);
    addEntry(map, entry({ source: "identity" }), 1);
    addEntry(map, entry({ list: "black", value: "spam@x.example", source: "ai" }), 1);
    expect(whiteListIsOnlyIdentities(map)).toBe(true);
    addEntry(map, entry({ value: "contact@x.example", source: "scan" }), 1);
    expect(whiteListIsOnlyIdentities(map)).toBe(false);
  });
});
