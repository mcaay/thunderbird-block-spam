// Undo for the four commands, and what the popup learns about the sender of the selected message.

import { describe, expect, it } from "vitest";
import { undoneEntries } from "../../src/core/commands";
import { entryKey } from "../../src/core/lists";
import type { Entry } from "../../src/core/types";
import { harness, INBOX1, JUNK1, SCREEN1 } from "../helpers/harness";

const entries = (h: { state: { entries: Map<string, Entry> } }): Entry[] => [...h.state.entries.values()].map((entry) => ({ ...entry }));

describe("undoing a command", () => {
  it("removes the entry a block added and moves the message back", async () => {
    const h = await harness();
    const before = entries(h);
    const msg = h.mail.put(INBOX1, { author: "cold@outreach.example" });
    const outcome = await h.engine.runCommand("block-address", [msg]);
    expect(outcome.undo).toEqual({
      remove: [entryKey("address", "cold@outreach.example", "all")],
      restore: [],
      moves: [{ accountId: "account1", messageId: msg.headerMessageId, from: INBOX1, to: JUNK1 }],
    });
    // The outcome says where the message is again, so that the line after Undo can name the place.
    expect(await h.engine.undoCommand(outcome.undo)).toEqual({ moved: 1, notFound: 0, failures: [], back: [{ place: "inbox", folder: INBOX1 }] });
    expect(entries(h)).toEqual(before);
    expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
    expect(h.mail.ids(JUNK1)).toEqual([]);
  });

  it("puts back exactly the entries a command replaced or removed, with their source and date", async () => {
    const h = await harness();
    // The domain was blocked by the AI, one address inside it was trusted by hand.
    h.state.addEntry({ list: "black", kind: "domain", value: "outreach.example", scope: "all", source: "ai" }, 5);
    h.state.addEntry({ list: "white", kind: "address", value: "anna@outreach.example", scope: "all", source: "sent" }, 6);
    const before = entries(h);
    const msg = h.mail.put(JUNK1, { author: "mike@outreach.example" });
    // Trusting the domain moves its entry to the white list.
    const trusted = await h.engine.runCommand("trust-domain", [msg]);
    expect(trusted.undo.remove).toEqual([]);
    expect(trusted.undo.restore).toEqual([{ list: "black", kind: "domain", value: "outreach.example", scope: "all", source: "ai", addedAt: 5 }]);
    expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
    await h.engine.undoCommand(trusted.undo);
    expect(entries(h)).toEqual(before);
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);

    // Blocking the address of a trusted sender removes the white entry that decided it.
    const anna = h.mail.put(INBOX1, { author: "anna@outreach.example" });
    const blocked = await h.engine.runCommand("block-address", [anna]);
    expect(h.state.entries.get(entryKey("address", "anna@outreach.example", "all"))?.list).toBe("black");
    await h.engine.undoCommand(blocked.undo);
    expect(entries(h)).toEqual(before);
  });

  it("records nothing to take back when the command changed nothing", async () => {
    const h = await harness();
    h.state.addEntry({ list: "black", kind: "address", value: "cold@outreach.example", scope: "all", source: "manual" }, 5);
    const msg = h.mail.put(JUNK1, { author: "cold@outreach.example" });
    const outcome = await h.engine.runCommand("block-address", [msg]);
    expect(outcome.undo).toEqual({ remove: [], restore: [], moves: [] });
  });

  it("takes back a command on several messages, and leaves alone a message that was moved on since", async () => {
    const h = await harness();
    const a = h.mail.put(INBOX1, { author: "a@outreach.example" });
    const b = h.mail.put(INBOX1, { author: "b@outreach.example" });
    const outcome = await h.engine.runCommand("block-domain", [a, b]);
    expect(h.mail.ids(JUNK1)).toEqual([a.id, b.id]);
    // The user deletes one of them from Junk before pressing Undo.
    h.mail.folder(JUNK1).messages = h.mail.folder(JUNK1).messages.filter((item) => item.id !== b.id);
    expect(await h.engine.undoCommand(outcome.undo)).toEqual({ moved: 1, notFound: 1, failures: [], back: [{ place: "inbox", folder: INBOX1 }] });
    expect(h.mail.ids(INBOX1)).toEqual([a.id]);
    expect(h.state.entries.has(entryKey("domain", "outreach.example", "all"))).toBe(false);
  });

  it("reports a move that failed and still restores the lists", async () => {
    const h = await harness();
    const msg = h.mail.put(INBOX1, { author: "cold@outreach.example" });
    const outcome = await h.engine.runCommand("block-address", [msg]);
    h.mail.failMoves = true;
    expect(await h.engine.undoCommand(outcome.undo)).toEqual({ moved: 0, notFound: 0, failures: ["move refused"], back: [] });
    expect(h.state.entries.size).toBe(0 + [...h.state.entries.values()].filter((entry) => entry.source === "identity").length);
  });
});

describe("what is true again after a command was taken back", () => {
  it("says for every entry which list it is on again, or that it is on neither", async () => {
    const h = await harness();
    h.state.addEntry({ list: "white", kind: "address", value: "anna@outreach.example", scope: "all", source: "sent" }, 6);
    const anna = h.mail.put(INBOX1, { author: "anna@outreach.example" });
    // Blocking the domain adds its entry and removes the white address that would still decide Anna.
    const blocked = await h.engine.runCommand("block-domain", [anna]);
    expect(undoneEntries(blocked.undo, h.state.entries)).toEqual([
      { value: "outreach.example", list: null },
      { value: "anna@outreach.example", list: "white" },
    ]);
    await h.engine.undoCommand(blocked.undo);

    // Blocking the address moves its entry to the black list: taken back, it is on the white list again.
    const moved = await h.engine.runCommand("block-address", [h.mail.put(INBOX1, { author: "anna@outreach.example" })]);
    expect(undoneEntries(moved.undo, h.state.entries)).toEqual([{ value: "anna@outreach.example", list: "white" }]);
  });

  it("names an added entry also when it was removed by hand since, and leaves out an entry of which only the source goes back", async () => {
    const h = await harness();
    const outcome = await h.engine.runCommand("block-address", [h.mail.put(INBOX1, { author: "cold@outreach.example" })]);
    h.state.removeEntry(entryKey("address", "cold@outreach.example", "all"));
    expect(undoneEntries(outcome.undo, h.state.entries)).toEqual([{ value: "cold@outreach.example", list: null }]);

    // Trusting a sender who was learned from sent mail only marks the entry as made by hand: it never leaves its list.
    h.state.addEntry({ list: "white", kind: "address", value: "anna@customer.example", scope: "all", source: "sent" }, 6);
    const trusted = await h.engine.runCommand("trust-address", [h.mail.put(INBOX1, { author: "anna@customer.example" })]);
    expect(trusted.undo.restore).toHaveLength(1);
    expect(undoneEntries(trusted.undo, h.state.entries)).toEqual([]);
  });

  it("says where a message is again: the Spam folder, the Inbox, or the folder it came from", async () => {
    const h = await harness();
    h.mail.addFolder(SCREEN1);
    h.state.settings.screeningFolders = [SCREEN1];
    const junked = await h.engine.runCommand("trust-address", [h.mail.put(JUNK1, { author: "a@customer.example" })]);
    expect((await h.engine.undoCommand(junked.undo)).back).toEqual([{ place: "junk", folder: JUNK1 }]);
    const screened = await h.engine.runCommand("trust-address", [h.mail.put(SCREEN1, { author: "b@customer.example" })]);
    expect((await h.engine.undoCommand(screened.undo)).back).toEqual([{ place: "folder", folder: SCREEN1 }]);
  });
});

describe("the entry a command leaves in place", () => {
  it("is the entry of the other list that decides the sender and that the target beats", async () => {
    const h = await harness();
    h.state.addEntry({ list: "black", kind: "domain", value: "outreach.example", scope: "all", source: "ai" }, 5);
    const msg = h.mail.put(JUNK1, { author: "mike@outreach.example" });
    const { effects } = await h.engine.describeSender(msg);
    // Trusting the address leaves the entry of the domain on the black list: the next sender of that domain is blocked again.
    expect(effects["trust-address"]?.kept).toEqual({ value: "outreach.example", list: "black" });
    // Trusting the domain moves that very entry, and a block is on the same side as the entry.
    expect(effects["trust-domain"]?.kept).toBeNull();
    expect(effects["block-address"]?.kept).toBeNull();
    expect(effects["block-domain"]?.kept).toBeNull();
  });

  it("is none when the command removes the deciding entry, or when the sender is on neither list", async () => {
    const h = await harness();
    const msg = h.mail.put(INBOX1, { author: "anna@customer.example" });
    expect(Object.values((await h.engine.describeSender(msg)).effects).map((effect) => effect.kept)).toEqual([null, null, null, null]);
    h.state.addEntry({ list: "white", kind: "address", value: "anna@customer.example", scope: "all", source: "sent" }, 5);
    const { effects } = await h.engine.describeSender(msg);
    // A white address beats a black domain, so the block of the domain removes it: nothing that decides is left in place.
    expect(effects["block-domain"]).toMatchObject({ lifted: [{ kind: "address", value: "anna@customer.example" }], kept: null });
    expect(effects["block-address"]?.kept).toBeNull();
  });
});

describe("what the lists say about the sender of a message", () => {
  it("names the deciding entry, the message, and the commands that would change nothing", async () => {
    const h = await harness();
    const msg = h.mail.put(INBOX1, { author: "mike@mail.outreach.example" });
    expect(await h.engine.describeSender(msg)).toMatchObject({
      deciding: null,
      accountId: "account1",
      messageId: msg.headerMessageId,
      unchanged: [],
    });

    h.state.addEntry({ list: "white", kind: "domain", value: "outreach.example", scope: "all", source: "sent" }, 5);
    const trusted = await h.engine.describeSender(msg);
    expect(trusted.deciding).toMatchObject({ list: "white", kind: "domain", value: "outreach.example" });
    // In the Inbox and already trusted: neither trust command would change anything.
    expect(trusted.unchanged).toEqual(["trust-address", "trust-domain"]);
  });

  it("still offers trust for a trusted sender whose message sits in Junk or a screening folder", async () => {
    const h = await harness();
    h.mail.addFolder(SCREEN1);
    h.state.settings.screeningFolders = [SCREEN1];
    h.state.addEntry({ list: "white", kind: "address", value: "anna@customer.example", scope: "all", source: "manual" }, 5);
    const junked = h.mail.put(JUNK1, { author: "anna@customer.example" });
    const screened = h.mail.put(SCREEN1, { author: "anna@customer.example" });
    expect((await h.engine.describeSender(junked)).unchanged).toEqual([]);
    expect((await h.engine.describeSender(screened)).unchanged).toEqual([]);
  });

  it("offers the domain command while only the address is on the list, and block only until the message is in Junk", async () => {
    const h = await harness();
    h.state.addEntry({ list: "black", kind: "address", value: "cold@outreach.example", scope: "all", source: "manual" }, 5);
    const inbox = h.mail.put(INBOX1, { author: "cold@outreach.example" });
    const junk = h.mail.put(JUNK1, { author: "cold@outreach.example" });
    // In the Inbox a block still moves the message.
    expect((await h.engine.describeSender(inbox)).unchanged).toEqual([]);
    // In Junk the address is done, the domain as a whole is not blocked yet.
    expect((await h.engine.describeSender(junk)).unchanged).toEqual(["block-address"]);
    h.state.addEntry({ list: "black", kind: "domain", value: "outreach.example", scope: "all", source: "manual" }, 6);
    expect((await h.engine.describeSender(junk)).unchanged).toEqual(["block-address", "block-domain"]);
  });

  it("finds the first copy of a message by its Message-ID", async () => {
    const h = await harness();
    const msg = h.mail.put(JUNK1, { author: "cold@outreach.example" });
    expect((await h.engine.findMessage("account1", msg.headerMessageId))?.id).toBe(msg.id);
    expect(await h.engine.findMessage("account1", "gone@test")).toBeNull();
    expect(await h.engine.findMessage("account1", "")).toBeNull();
  });
});
