import { describe, expect, it } from "vitest";
import { COMMANDS, isCommandName } from "../../src/core/commands";
import { entryKey } from "../../src/core/lists";
import { KEY_ENTRIES } from "../../src/core/state";
import type { Entry } from "../../src/core/types";
import { reload } from "../helpers/fakes";
import { harness, INBOX1, INBOX2, JUNK1, JUNK2, SCREEN1 } from "../helpers/harness";

describe("command names", () => {
  it("accepts exactly the four commands", () => {
    expect([...COMMANDS]).toEqual(["block-address", "block-domain", "trust-address", "trust-domain"]);
    expect(isCommandName("block-domain")).toBe(true);
    expect(isCommandName("delete-everything")).toBe(false);
    expect(isCommandName(undefined)).toBe(false);
  });
});

describe("block", () => {
  it("block address adds the address with source manual and moves the message to Junk", async () => {
    const h = await harness();
    const msg = h.mail.put(INBOX1, { author: "Cold <Cold@Outreach.example>" });
    const outcome = await h.engine.runCommand("block-address", [msg]);
    expect(h.state.entries.get(entryKey("address", "cold@outreach.example", "all"))).toMatchObject({ list: "black", source: "manual" });
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
    expect(outcome.plan.targets).toEqual([{ kind: "address", value: "cold@outreach.example" }]);
    expect(outcome.moved).toBe(1);
    expect(outcome.failures).toEqual([]);
    expect((await reload(h.store)).entries.size).toBe(1);
  });

  it("block domain with Smart on blocks a company by domain and a public sender by address", async () => {
    const h = await harness();
    const company = h.mail.put(INBOX1, { author: "mike@mail.outreach.example" });
    const personal = h.mail.put(INBOX1, { author: "spammer@gmail.com" });
    const outcome = await h.engine.runCommand("block-domain", [company, personal]);
    expect(h.state.entries.get(entryKey("domain", "outreach.example", "all"))?.list).toBe("black");
    expect(h.state.entries.get(entryKey("address", "spammer@gmail.com", "all"))?.list).toBe("black");
    expect(h.state.entries.has(entryKey("domain", "gmail.com", "all"))).toBe(false);
    expect(outcome.plan.targets).toEqual([
      { kind: "domain", value: "outreach.example" },
      { kind: "address", value: "spammer@gmail.com" },
    ]);
  });

  it("block domain with Smart off always uses the registrable domain", async () => {
    const h = await harness();
    h.state.settings.smart = false;
    const personal = h.mail.put(INBOX1, { author: "spammer@gmail.com" });
    await h.engine.runCommand("block-domain", [personal]);
    expect(h.state.entries.get(entryKey("domain", "gmail.com", "all"))).toMatchObject({ list: "black", source: "manual" });
    expect(h.state.entries.has(entryKey("address", "spammer@gmail.com", "all"))).toBe(false);
  });

  it("works on several selected messages at once and lists each target once", async () => {
    const h = await harness();
    const a = h.mail.put(INBOX1, { author: "a@outreach.example" });
    const b = h.mail.put(INBOX1, { author: "b@outreach.example" });
    const c = h.mail.put(INBOX2, { author: "c@other.example" });
    const outcome = await h.engine.runCommand("block-domain", [a, b, c]);
    expect(outcome.plan.targets).toEqual([
      { kind: "domain", value: "outreach.example" },
      { kind: "domain", value: "other.example" },
    ]);
    expect(h.mail.ids(JUNK1).sort()).toEqual([a.id, b.id].sort());
    expect(h.mail.ids(JUNK2)).toEqual([c.id]);
    expect(outcome.moved).toBe(3);
  });

  it("ignores messages sent by one of the user's own addresses", async () => {
    const h = await harness();
    const own = h.mail.put(INBOX1, { author: "Me <me@mycompany.example>" });
    const outcome = await h.engine.runCommand("block-domain", [own]);
    expect(h.state.entries.size).toBe(0);
    expect(h.mail.ids(INBOX1)).toEqual([own.id]);
    expect(outcome.plan.ignoredOwn).toBe(1);
    expect(outcome.moved).toBe(0);
  });

  it("uses the account as scope when new entries are per account", async () => {
    const h = await harness();
    h.state.settings.newEntryScope = "account";
    const msg = h.mail.put(INBOX2, { author: "a@outreach.example" });
    await h.engine.runCommand("block-address", [msg]);
    expect(h.state.entries.has(entryKey("address", "a@outreach.example", "account2"))).toBe(true);
  });

  it("writes the entry before the move", async () => {
    const h = await harness();
    const msg = h.mail.put(INBOX1, { author: "a@outreach.example" });
    let storedAtMove: Entry[] = [];
    const move = h.mail.move.bind(h.mail);
    h.mail.move = async (ids, target) => {
      storedAtMove = structuredClone((h.store.data[KEY_ENTRIES] ?? []) as Entry[]);
      await move(ids, target);
    };
    await h.engine.runCommand("block-address", [msg]);
    expect(storedAtMove).toHaveLength(1);
  });

  it("keeps the entry and reports the failure when the move fails", async () => {
    const h = await harness();
    h.mail.failMoves = true;
    const msg = h.mail.put(INBOX1, { author: "a@outreach.example" });
    const outcome = await h.engine.runCommand("block-address", [msg]);
    expect(h.state.entries.size).toBe(1);
    expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
    expect(outcome.failures).toEqual(["move refused"]);
    expect(outcome.moved).toBe(0);
  });

  it("reports an account without a Junk folder", async () => {
    const h = await harness();
    h.mail.removeFolder(JUNK1);
    const msg = h.mail.put(INBOX1, { author: "a@outreach.example" });
    const outcome = await h.engine.runCommand("block-address", [msg]);
    expect(outcome.failures).toEqual(["no-junk-folder"]);
    expect(h.state.entries.size).toBe(1);
  });

  it("works in observation mode and while protection is off", async () => {
    const h = await harness();
    h.state.settings.observation = true;
    expect(h.state.settings.protection).toBe(false);
    const msg = h.mail.put(INBOX1, { author: "a@outreach.example" });
    await h.engine.runCommand("block-address", [msg]);
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
  });

  it("replaces a white list entry with the same key, whatever its source", async () => {
    const h = await harness();
    h.state.addEntry({ list: "white", kind: "domain", value: "outreach.example", scope: "all", source: "sent" }, 1);
    const msg = h.mail.put(INBOX1, { author: "a@outreach.example" });
    await h.engine.runCommand("block-domain", [msg]);
    expect(h.state.entries.size).toBe(1);
    expect(h.state.entries.get(entryKey("domain", "outreach.example", "all"))).toMatchObject({ list: "black", source: "manual" });
  });

  it("removes an older white list entry that would still decide this sender", async () => {
    const h = await harness();
    h.state.addEntry({ list: "white", kind: "address", value: "a@outreach.example", scope: "all", source: "sent" }, 1);
    h.state.addEntry({ list: "white", kind: "address", value: "other@outreach.example", scope: "all", source: "sent" }, 1);
    const msg = h.mail.put(INBOX1, { author: "a@outreach.example" });
    await h.engine.runCommand("block-domain", [msg]);
    expect(h.state.entries.has(entryKey("address", "a@outreach.example", "all"))).toBe(false);
    expect(h.state.entries.get(entryKey("domain", "outreach.example", "all"))?.list).toBe("black");
    // Entries about other senders are not touched.
    expect(h.state.entries.get(entryKey("address", "other@outreach.example", "all"))?.list).toBe("white");
  });

  it("names the entry it removed, so that nothing changes that the result does not say", async () => {
    const h = await harness();
    h.state.addEntry({ list: "white", kind: "address", value: "a@outreach.example", scope: "all", source: "sent" }, 1);
    const msg = h.mail.put(INBOX1, { author: "a@outreach.example" });
    const outcome = await h.engine.runCommand("block-domain", [msg, h.mail.put(INBOX1, { author: "a@outreach.example" })]);
    expect(outcome.plan.targets).toEqual([{ kind: "domain", value: "outreach.example" }]);
    // Named once, also when several messages of the sender were selected.
    expect(outcome.plan.lifted).toMatchObject([{ list: "white", kind: "address", value: "a@outreach.example" }]);
  });
});

describe("trust", () => {
  it("trust address adds the address and moves the message from Junk to the Inbox", async () => {
    const h = await harness();
    const msg = h.mail.put(JUNK1, { author: "anna@customer.example" });
    const outcome = await h.engine.runCommand("trust-address", [msg]);
    expect(h.state.entries.get(entryKey("address", "anna@customer.example", "all"))).toMatchObject({ list: "white", source: "manual" });
    expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
    expect(outcome.plan.list).toBe("white");
    expect(outcome.moved).toBe(1);
  });

  it("trust domain follows Smart", async () => {
    const h = await harness();
    const company = h.mail.put(JUNK1, { author: "anna@customer.example" });
    const personal = h.mail.put(JUNK1, { author: "friend@gmail.com" });
    await h.engine.runCommand("trust-domain", [company, personal]);
    expect(h.state.entries.get(entryKey("domain", "customer.example", "all"))?.list).toBe("white");
    expect(h.state.entries.get(entryKey("address", "friend@gmail.com", "all"))?.list).toBe("white");

    h.state.settings.smart = false;
    const other = h.mail.put(JUNK1, { author: "x@yahoo.com" });
    await h.engine.runCommand("trust-domain", [other]);
    expect(h.state.entries.get(entryKey("domain", "yahoo.com", "all"))?.list).toBe("white");
  });

  it("moves from a screening folder to the Inbox and leaves other folders alone", async () => {
    const h = await harness();
    h.mail.addFolder(SCREEN1);
    h.state.settings.screeningFolders = [SCREEN1];
    const projects = h.mail.addFolder({ accountId: "account1", path: "/Projects" });
    const screened = h.mail.put(SCREEN1, { author: "anna@customer.example" });
    const filed = h.mail.put(projects, { author: "bob@partner.example" });
    const outcome = await h.engine.runCommand("trust-address", [screened, filed]);
    expect(h.mail.ids(INBOX1)).toEqual([screened.id]);
    expect(h.mail.ids(projects)).toEqual([filed.id]);
    expect(outcome.moved).toBe(1);
  });

  it("releases other messages of the trusted sender from screening", async () => {
    const h = await harness();
    h.mail.addFolder(SCREEN1);
    h.state.settings.screeningFolders = [SCREEN1];
    const selected = h.mail.put(SCREEN1, { author: "anna@customer.example" });
    const sibling = h.mail.put(SCREEN1, { author: "boss@customer.example" });
    const stranger = h.mail.put(SCREEN1, { author: "x@unknown.example" });
    await h.engine.runCommand("trust-domain", [selected]);
    expect(h.mail.ids(INBOX1).sort()).toEqual([selected.id, sibling.id].sort());
    expect(h.mail.ids(SCREEN1)).toEqual([stranger.id]);
  });

  it("lifts a manual block: an address exception inside a blocked domain", async () => {
    const h = await harness();
    h.state.addEntry({ list: "black", kind: "domain", value: "customer.example", scope: "all", source: "manual" }, 1);
    const msg = h.mail.put(JUNK1, { author: "anna@customer.example" });
    await h.engine.runCommand("trust-address", [msg]);
    expect(h.state.entries.get(entryKey("domain", "customer.example", "all"))?.list).toBe("black");
    expect(h.state.entries.get(entryKey("address", "anna@customer.example", "all"))?.list).toBe("white");
  });

  it("lifts a manual block of the same domain", async () => {
    const h = await harness();
    h.state.addEntry({ list: "black", kind: "domain", value: "customer.example", scope: "all", source: "manual" }, 1);
    const msg = h.mail.put(JUNK1, { author: "anna@customer.example" });
    await h.engine.runCommand("trust-domain", [msg]);
    expect(h.state.entries.size).toBe(1);
    expect(h.state.entries.get(entryKey("domain", "customer.example", "all"))).toMatchObject({ list: "white", source: "manual" });
  });

  it("removes a blocked address entry when the sender's domain is trusted", async () => {
    const h = await harness();
    h.state.addEntry({ list: "black", kind: "address", value: "anna@customer.example", scope: "all", source: "ai" }, 1);
    const msg = h.mail.put(JUNK1, { author: "anna@customer.example" });
    await h.engine.runCommand("trust-domain", [msg]);
    expect(h.state.entries.has(entryKey("address", "anna@customer.example", "all"))).toBe(false);
    expect(h.state.entries.get(entryKey("domain", "customer.example", "all"))?.list).toBe("white");
  });

  it("removes a block scoped to the account when the new entry is shared", async () => {
    const h = await harness();
    h.state.addEntry({ list: "black", kind: "address", value: "anna@customer.example", scope: "account1", source: "manual" }, 1);
    const msg = h.mail.put(JUNK1, { author: "anna@customer.example" });
    await h.engine.runCommand("trust-address", [msg]);
    expect(h.state.entries.has(entryKey("address", "anna@customer.example", "account1"))).toBe(false);
    expect(h.state.entries.get(entryKey("address", "anna@customer.example", "all"))?.list).toBe("white");
  });
});

describe("commands on forwarded mail", () => {
  const FORWARDER = "office@partner.example";

  it("acts on the effective sender, not on the forwarding mailbox", async () => {
    const h = await harness();
    h.state.settings.forwardingMailboxes = [FORWARDER];
    h.state.refreshDerived();
    const msg = h.mail.put(INBOX1, { author: FORWARDER, headers: { "x-original-from": ["cold@outreach.example"] } });
    const outcome = await h.engine.runCommand("block-domain", [msg]);
    expect(outcome.plan.targets).toEqual([{ kind: "domain", value: "outreach.example" }]);
    expect(h.state.entries.has(entryKey("domain", "partner.example", "all"))).toBe(false);
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
  });

  it("only moves the message when the effective sender cannot be determined", async () => {
    const h = await harness();
    h.state.settings.forwardingMailboxes = [FORWARDER];
    h.state.refreshDerived();
    const msg = h.mail.put(INBOX1, { author: FORWARDER, body: "nothing useful" });
    const outcome = await h.engine.runCommand("block-address", [msg]);
    expect(h.state.entries.size).toBe(0);
    expect(outcome.plan.targets).toEqual([]);
    expect(outcome.plan.unknownSenders).toBe(1);
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
    expect(h.store.data[KEY_ENTRIES]).toBeUndefined();
  });
});
