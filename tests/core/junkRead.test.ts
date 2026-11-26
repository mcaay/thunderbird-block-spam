// Mail that Block Spam moves to Junk is marked read, so that Junk shows no unread count.
// Taking the decision back marks it unread again.

import { describe, expect, it } from "vitest";
import type { LogEntry } from "../../src/core/types";
import type { FakeMessage } from "../helpers/fakes";
import { accessPoint, harness, HOUR, INBOX1, JUNK1, SCREEN1 } from "../helpers/harness";
import type { Harness } from "../helpers/harness";

async function protectedHarness(): Promise<Harness> {
  const h = await harness();
  h.protect();
  h.clock.now += HOUR;
  return h;
}

function arrived(h: Harness): number {
  return h.clock.now - 10 * 60 * 1000;
}

function blocked(h: Harness): void {
  h.state.addEntry({ list: "black", kind: "address", value: "cold@outreach.example", scope: "all", source: "manual" }, 1);
}

function logged(message: FakeMessage, partial: Partial<LogEntry>): LogEntry {
  return {
    time: 1,
    accountId: message.accountId,
    account: "Work",
    sender: message.author,
    via: "",
    subject: message.subject,
    outcome: "spam",
    action: "junk",
    score: null,
    accessPoint: "",
    reason: "ai-above",
    detail: "",
    observed: false,
    test: false,
    messageId: message.headerMessageId,
    ...partial,
  };
}

describe("mail moved to Junk by a decision", () => {
  it("is marked read, and the log says so", async () => {
    const h = await protectedHarness();
    blocked(h);
    const msg = h.mail.put(INBOX1, { author: "cold@outreach.example", date: arrived(h) });
    await h.engine.tick();
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
    expect(msg.read).toBe(true);
    expect(h.log()[0]).toMatchObject({ action: "junk", markedRead: true });
  });

  it("is marked read when the AI finds it spam or when mail without a verdict goes to Junk", async () => {
    const h = await protectedHarness();
    h.state.accessPoints = [accessPoint()];
    h.ai.replies["*"] = 0.93;
    const spam = h.mail.put(INBOX1, { author: "mike@mail.outreach.example", date: arrived(h) });
    await h.engine.tick();
    expect(spam.read).toBe(true);

    const other = await protectedHarness();
    other.state.settings.noVerdictAction = "junk";
    const unscored = other.mail.put(INBOX1, { author: "someone@unknown.example", date: arrived(other) });
    await other.engine.tick();
    expect(other.mail.ids(JUNK1)).toEqual([unscored.id]);
    expect(unscored.read).toBe(true);
  });

  it("stays unread with the option off", async () => {
    const h = await protectedHarness();
    h.state.settings.markJunkRead = false;
    blocked(h);
    const msg = h.mail.put(INBOX1, { author: "cold@outreach.example", date: arrived(h) });
    await h.engine.tick();
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
    expect(msg.read).toBe(false);
    expect(h.mail.readChanges).toEqual([]);
    expect(h.log()[0]?.markedRead).toBeUndefined();
  });

  it("is the only mail marked read: mail moved to a screening folder stays unread", async () => {
    const h = await protectedHarness();
    h.mail.addFolder(SCREEN1);
    h.state.settings.screeningFolders = [SCREEN1];
    h.state.settings.noVerdictAction = "screening";
    const msg = h.mail.put(INBOX1, { author: "someone@unknown.example", date: arrived(h) });
    await h.engine.tick();
    expect(h.mail.ids(SCREEN1)).toEqual([msg.id]);
    expect(msg.read).toBe(false);
    expect(h.mail.readChanges).toEqual([]);
  });

  it("that is read already is not changed, so trust from the log leaves it read", async () => {
    const h = await protectedHarness();
    blocked(h);
    const msg = h.mail.put(INBOX1, { author: "cold@outreach.example", date: arrived(h), read: true });
    await h.engine.tick();
    const [entry] = h.log();
    expect(entry?.markedRead).toBeUndefined();
    expect(h.mail.readChanges).toEqual([]);
    if (entry !== undefined) {
      await h.engine.runLogAction(entry, "trust");
    }
    expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
    expect(msg.read).toBe(true);
  });

  it("is still moved when it cannot be marked read", async () => {
    const h = await protectedHarness();
    blocked(h);
    h.mail.failSetRead = true;
    const msg = h.mail.put(INBOX1, { author: "cold@outreach.example", date: arrived(h) });
    await h.engine.tick();
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
    expect(msg.read).toBe(false);
    expect(h.log()[0]).toMatchObject({ action: "junk" });
    expect(h.log()[0]?.markedRead).toBeUndefined();
  });

  it("is unread again when the move fails", async () => {
    const h = await protectedHarness();
    blocked(h);
    h.mail.failMoves = true;
    const msg = h.mail.put(INBOX1, { author: "cold@outreach.example", date: arrived(h) });
    await h.engine.tick();
    expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
    expect(msg.read).toBe(false);
    expect(h.mail.readChanges).toEqual([
      { ids: [msg.id], read: true },
      { ids: [msg.id], read: false },
    ]);
    expect(h.log()[0]).toMatchObject({ action: "none", reason: "move-failed" });
    expect(h.log()[0]?.markedRead).toBeUndefined();
  });
});

describe("mail moved to Junk by a command", () => {
  it("is marked read, and Undo marks it unread again", async () => {
    const h = await harness();
    const msg = h.mail.put(INBOX1, { author: "cold@outreach.example" });
    const outcome = await h.engine.runCommand("block-address", [msg]);
    expect(msg.read).toBe(true);
    expect(outcome.undo.moves).toEqual([{ accountId: "account1", messageId: msg.headerMessageId, from: INBOX1, to: JUNK1, readBefore: false }]);
    await h.engine.undoCommand(outcome.undo);
    expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
    expect(msg.read).toBe(false);
  });

  it("that was read stays read after Undo, and trust leaves the read state alone", async () => {
    const h = await harness();
    const msg = h.mail.put(INBOX1, { author: "cold@outreach.example", read: true });
    const outcome = await h.engine.runCommand("block-address", [msg]);
    expect(outcome.undo.moves[0]?.readBefore).toBeUndefined();
    await h.engine.undoCommand(outcome.undo);
    expect(msg.read).toBe(true);

    const unread = h.mail.put(JUNK1, { author: "anna@customer.example" });
    await h.engine.runCommand("trust-address", [unread]);
    expect(h.mail.ids(INBOX1)).toContain(unread.id);
    expect(unread.read).toBe(false);
  });

  it("stays unread with the option off", async () => {
    const h = await harness();
    h.state.settings.markJunkRead = false;
    const msg = h.mail.put(INBOX1, { author: "cold@outreach.example" });
    const outcome = await h.engine.runCommand("block-address", [msg]);
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
    expect(msg.read).toBe(false);
    expect(outcome.undo.moves[0]?.readBefore).toBeUndefined();
  });
});

describe("the log", () => {
  it("trust marks unread again what Block Spam marked read, and its Undo marks it read again", async () => {
    const h = await harness();
    const msg = h.mail.put(JUNK1, { author: "growth@leadgen.example", read: true });
    const outcome = await h.engine.runLogAction(logged(msg, { markedRead: true }), "trust");
    expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
    expect(msg.read).toBe(false);
    expect(outcome.undo.move).toEqual({ from: JUNK1, to: INBOX1, readBefore: true });
    await h.engine.undoLogAction(outcome.undo);
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
    expect(msg.read).toBe(true);
  });

  it("trust leaves read mail that Block Spam did not mark", async () => {
    const h = await harness();
    const msg = h.mail.put(JUNK1, { author: "growth@leadgen.example", read: true });
    const outcome = await h.engine.runLogAction(logged(msg, {}), "trust");
    expect(msg.read).toBe(true);
    expect(outcome.undo.move).toEqual({ from: JUNK1, to: INBOX1 });
  });

  it("block marks the message read, and its Undo marks it unread again", async () => {
    const h = await harness();
    const msg = h.mail.put(INBOX1, { author: "sales@cold.example" });
    const outcome = await h.engine.runLogAction(logged(msg, { outcome: "passed", action: "none", reason: "ai-below" }), "block");
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
    expect(msg.read).toBe(true);
    expect(outcome.undo.move).toEqual({ from: INBOX1, to: JUNK1, readBefore: false });
    await h.engine.undoLogAction(outcome.undo);
    expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
    expect(msg.read).toBe(false);
  });
});
