// Undo for the four commands, and what the popup learns about the sender of the selected message.

import { describe, expect, it } from "vitest";
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
    expect(await h.engine.undoCommand(outcome.undo)).toEqual({ moved: 1, notFound: 0, failures: [] });
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
    expect(await h.engine.undoCommand(outcome.undo)).toEqual({ moved: 1, notFound: 1, failures: [] });
    expect(h.mail.ids(INBOX1)).toEqual([a.id]);
    expect(h.state.entries.has(entryKey("domain", "outreach.example", "all"))).toBe(false);
  });

  it("reports a move that failed and still restores the lists", async () => {
    const h = await harness();
    const msg = h.mail.put(INBOX1, { author: "cold@outreach.example" });
    const outcome = await h.engine.runCommand("block-address", [msg]);
    h.mail.failMoves = true;
    expect(await h.engine.undoCommand(outcome.undo)).toEqual({ moved: 0, notFound: 0, failures: ["move refused"] });
    expect(h.state.entries.size).toBe(0 + [...h.state.entries.values()].filter((entry) => entry.source === "identity").length);
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
