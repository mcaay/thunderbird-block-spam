import { describe, expect, it } from "vitest";
import { entryKey } from "../../src/core/lists";
import { expectsMove, fittingAction, isLogAction, logOffer } from "../../src/core/logAction";
import { backPlace, logLabel, logResult, logUndone } from "../../src/options/logLabels";
import { ValidationError } from "../../src/core/settings";
import { KEY_ENTRIES } from "../../src/core/state";
import type { Entry, FolderRef, LogEntry } from "../../src/core/types";
import { reload } from "../helpers/fakes";
import type { FakeMessage } from "../helpers/fakes";
import { harness, INBOX1, INBOX2, JUNK1, JUNK2, SCREEN1 } from "../helpers/harness";
import type { Harness } from "../helpers/harness";

/** The log entry of a decision about a message, as the pipeline would have written it. */
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

function entry(h: Harness, kind: "address" | "domain", value: string, scope = "all"): Entry | undefined {
  return h.state.entries.get(entryKey(kind, value, scope));
}

describe("the action that fits a log entry", () => {
  const base = { outcome: "spam", action: "junk", test: false, sender: "a@b.example", messageId: "m@test" } as const;

  it("trusts after a decision against the sender and blocks after any other", () => {
    expect(fittingAction(base)).toBe("trust");
    expect(fittingAction({ ...base, outcome: "blocked" })).toBe("trust");
    expect(fittingAction({ ...base, outcome: "no-verdict", action: "screening" })).toBe("trust");
    expect(fittingAction({ ...base, outcome: "no-verdict", action: "junk" })).toBe("trust");
    expect(fittingAction({ ...base, outcome: "no-verdict", action: "none" })).toBe("block");
    expect(fittingAction({ ...base, outcome: "passed", action: "none" })).toBe("block");
    expect(fittingAction({ ...base, outcome: "trusted", action: "none" })).toBe("block");
    expect(fittingAction({ ...base, outcome: "released", action: "inbox" })).toBe("block");
  });

  it("offers nothing for tests, errors and entries without a sender or a Message-ID", () => {
    expect(fittingAction({ ...base, test: true })).toBeNull();
    expect(fittingAction({ ...base, outcome: "error", action: "none" })).toBeNull();
    expect(fittingAction({ ...base, sender: "" })).toBeNull();
    // Entries logged before the Message-ID was recorded load with an empty value.
    expect(fittingAction({ ...base, messageId: "" })).toBeNull();
  });

  it("moves the message back only when the decision had moved it", () => {
    expect(expectsMove({ action: "junk", observed: false, test: false }, "trust")).toBe(true);
    expect(expectsMove({ action: "screening", observed: false, test: false }, "trust")).toBe(true);
    expect(expectsMove({ action: "junk", observed: true, test: false }, "trust")).toBe(false);
    expect(expectsMove({ action: "none", observed: false, test: false }, "trust")).toBe(false);
    expect(expectsMove({ action: "none", observed: false, test: false }, "block")).toBe(true);
    expect(expectsMove({ action: "none", observed: true, test: false }, "block")).toBe(true);
    expect(expectsMove({ action: "none", observed: false, test: true }, "block")).toBe(false);
  });

  it("knows the two actions", () => {
    expect(isLogAction("trust")).toBe(true);
    expect(isLogAction("block")).toBe(true);
    expect(isLogAction("delete")).toBe(false);
    expect(isLogAction(undefined)).toBe(false);
  });
});

/** What a row would offer, as the page computes it. */
function offered(h: Harness, row: LogEntry, action: "trust" | "block") {
  return logOffer({ entries: h.state.entries, publicDomains: h.state.publicDomains, newEntryScope: (accountId) => h.state.newEntryScope(accountId) }, row, action);
}

describe("trust from the log", () => {
  it("moves the black entry that decided to the white list and moves the message back to the Inbox", async () => {
    const h = await harness();
    h.state.addEntry({ list: "black", kind: "domain", value: "leadgen.example", scope: "all", source: "ai" }, 5);
    const msg = h.mail.put(JUNK1, { author: "growth@mail.leadgen.example" });
    const outcome = await h.engine.runLogAction(logged(msg, { sender: "growth@mail.leadgen.example" }), "trust");

    expect(entry(h, "domain", "leadgen.example")).toMatchObject({ list: "white", source: "manual" });
    expect(h.state.entries.size).toBe(1);
    expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
    expect(outcome).toMatchObject({ list: "white", change: "move", target: { kind: "domain", value: "leadgen.example" }, scope: "all", behind: null, move: "moved", failure: "" });
    expect((await reload(h.store)).entries.get(entryKey("domain", "leadgen.example", "all"))?.list).toBe("white");
  });

  it("trusts an address at a public provider alone", async () => {
    const h = await harness();
    h.state.addEntry({ list: "black", kind: "address", value: "friend@gmail.com", scope: "all", source: "ai" }, 5);
    const msg = h.mail.put(JUNK1, { author: "friend@gmail.com" });
    const outcome = await h.engine.runLogAction(logged(msg, {}), "trust");
    expect(outcome.target).toEqual({ kind: "address", value: "friend@gmail.com" });
    expect(entry(h, "address", "friend@gmail.com")?.list).toBe("white");
    expect(h.state.entries.has(entryKey("domain", "gmail.com", "all"))).toBe(false);
  });

  it("only removes a blocked address inside a trusted domain: the domain entry is not touched", async () => {
    const h = await harness();
    h.state.addEntry({ list: "white", kind: "domain", value: "partner.example", scope: "all", source: "sent" }, 1);
    h.state.addEntry({ list: "black", kind: "address", value: "news@partner.example", scope: "all", source: "manual" }, 2);
    const msg = h.mail.put(JUNK1, { author: "news@partner.example" });
    const outcome = await h.engine.runLogAction(logged(msg, { outcome: "blocked", reason: "black-address" }), "trust");
    expect(outcome).toMatchObject({ change: "remove", target: { kind: "address", value: "news@partner.example" }, behind: { kind: "domain", value: "partner.example" } });
    expect(h.state.entries.has(entryKey("address", "news@partner.example", "all"))).toBe(false);
    // The white entry of the domain is exactly as it was: its source is not made manual.
    expect(entry(h, "domain", "partner.example")).toEqual({ list: "white", kind: "domain", value: "partner.example", scope: "all", source: "sent", addedAt: 1 });
    expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
    await h.engine.undoLogAction(outcome.undo);
    expect(entry(h, "address", "news@partner.example")).toEqual({ list: "black", kind: "address", value: "news@partner.example", scope: "all", source: "manual", addedAt: 2 });
  });

  it("undoes the block of one address for that address, not by trusting its whole domain", async () => {
    const h = await harness();
    h.state.addEntry({ list: "black", kind: "address", value: "news@shop.example", scope: "all", source: "manual" }, 2);
    const msg = h.mail.put(JUNK1, { author: "news@shop.example" });
    const outcome = await h.engine.runLogAction(logged(msg, { outcome: "blocked", reason: "black-address" }), "trust");
    expect(outcome).toMatchObject({ change: "move", target: { kind: "address", value: "news@shop.example" } });
    expect(entry(h, "address", "news@shop.example")).toMatchObject({ list: "white", source: "manual" });
    expect(h.state.entries.has(entryKey("domain", "shop.example", "all"))).toBe(false);
    expect(h.state.entries.size).toBe(1);
  });

  it("keeps the scope of the entry that decided", async () => {
    const h = await harness();
    h.state.addEntry({ list: "black", kind: "domain", value: "leadgen.example", scope: "account1", source: "ai" }, 5);
    const msg = h.mail.put(JUNK1, { author: "growth@leadgen.example" });
    const outcome = await h.engine.runLogAction(logged(msg, {}), "trust");
    expect(outcome.scope).toBe("account1");
    expect(entry(h, "domain", "leadgen.example", "account1")?.list).toBe("white");
    expect(h.state.entries.size).toBe(1);
  });

  it("moves the message back from a screening folder and releases the sender's other mail there", async () => {
    const h = await harness();
    h.mail.addFolder(SCREEN1);
    h.state.settings.screeningFolders = [SCREEN1];
    const msg = h.mail.put(SCREEN1, { author: "anna@customer.example" });
    const sibling = h.mail.put(SCREEN1, { author: "boss@customer.example" });
    const outcome = await h.engine.runLogAction(logged(msg, { outcome: "no-verdict", action: "screening", reason: "no-ai" }), "trust");
    expect(outcome.move).toBe("moved");
    expect(h.mail.ids(INBOX1).sort()).toEqual([msg.id, sibling.id].sort());
  });

  it("only changes the lists after an observed decision, because nothing was moved", async () => {
    const h = await harness();
    const msg = h.mail.put(INBOX1, { author: "hello@growth.example" });
    const outcome = await h.engine.runLogAction(logged(msg, { observed: true }), "trust");
    expect(entry(h, "domain", "growth.example")?.list).toBe("white");
    expect(outcome.move).toBe("none");
    expect(h.mail.moves).toEqual([]);
    expect(outcome.undo.move).toBeNull();
  });

  it("still changes the lists when the message is no longer in Junk", async () => {
    const h = await harness();
    const filed = h.mail.addFolder({ accountId: "account1", path: "/Projects" });
    const msg = h.mail.put(filed, { author: "growth@leadgen.example" });
    const outcome = await h.engine.runLogAction(logged(msg, {}), "trust");
    expect(entry(h, "domain", "leadgen.example")?.list).toBe("white");
    expect(outcome.move).toBe("not-found");
    expect(h.mail.ids(filed)).toEqual([msg.id]);

    const gone = await h.engine.runLogAction(logged(msg, { messageId: "deleted@test", sender: "x@other.example" }), "trust");
    expect(gone.move).toBe("not-found");
    expect(entry(h, "domain", "other.example")?.list).toBe("white");
  });

  it("reports a failed move and keeps the entry", async () => {
    const h = await harness();
    const msg = h.mail.put(JUNK1, { author: "growth@leadgen.example" });
    h.mail.failMoves = true;
    const outcome = await h.engine.runLogAction(logged(msg, {}), "trust");
    expect(outcome).toMatchObject({ move: "failed", failure: "move refused" });
    expect(entry(h, "domain", "leadgen.example")?.list).toBe("white");
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
    expect(outcome.undo.move).toBeNull();
  });

  it("writes the entry before the move", async () => {
    const h = await harness();
    const msg = h.mail.put(JUNK1, { author: "growth@leadgen.example" });
    let storedAtMove: Entry[] = [];
    const move = h.mail.move.bind(h.mail);
    h.mail.move = async (ids: number[], target: FolderRef) => {
      storedAtMove = structuredClone((h.store.data[KEY_ENTRIES] ?? []) as Entry[]);
      await move(ids, target);
    };
    await h.engine.runLogAction(logged(msg, {}), "trust");
    expect(storedAtMove).toHaveLength(1);
  });

  it("uses the account of the entry as scope when new entries are per account", async () => {
    const h = await harness();
    h.state.settings.newEntryScope = "account";
    const msg = h.mail.put(JUNK2, { author: "growth@leadgen.example" });
    const outcome = await h.engine.runLogAction(logged(msg, {}), "trust");
    expect(outcome.scope).toBe("account2");
    expect(entry(h, "domain", "leadgen.example", "account2")?.list).toBe("white");
    expect(h.mail.ids(INBOX2)).toEqual([msg.id]);
  });
});

describe("block from the log", () => {
  it("blacklists the smart target of a sender that passed and moves the message to Junk", async () => {
    const h = await harness();
    const msg = h.mail.put(INBOX1, { author: "sales@cold.example" });
    const outcome = await h.engine.runLogAction(logged(msg, { outcome: "passed", action: "none", reason: "ai-below" }), "block");
    expect(entry(h, "domain", "cold.example")).toMatchObject({ list: "black", source: "manual" });
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
    expect(outcome).toMatchObject({ list: "black", change: "add", target: { kind: "domain", value: "cold.example" }, move: "moved" });
  });

  it("blacklists only the address of a trusted sender, so the domain keeps its trust", async () => {
    const h = await harness();
    h.state.addEntry({ list: "white", kind: "domain", value: "partner.example", scope: "all", source: "sent" }, 1);
    const msg = h.mail.put(INBOX1, { author: "newsletter@partner.example" });
    const outcome = await h.engine.runLogAction(logged(msg, { outcome: "trusted", action: "none", reason: "white-domain" }), "block");
    expect(outcome.target).toEqual({ kind: "address", value: "newsletter@partner.example" });
    expect(entry(h, "address", "newsletter@partner.example")).toMatchObject({ list: "black", source: "manual" });
    expect(entry(h, "domain", "partner.example")).toMatchObject({ list: "white", source: "sent" });
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
  });

  it("blacklists only the address when the domain was trusted after the sender had passed", async () => {
    const h = await harness();
    const msg = h.mail.put(INBOX1, { author: "newsletter@partner.example" });
    const passed = logged(msg, { outcome: "passed", action: "none", reason: "ai-below" });
    expect(offered(h, passed, "block")?.target).toEqual({ kind: "domain", value: "partner.example" });
    // The user wrote to the company in the meantime.
    h.state.addEntry({ list: "white", kind: "domain", value: "partner.example", scope: "all", source: "sent" }, 1);
    expect(offered(h, passed, "block")?.target).toEqual({ kind: "address", value: "newsletter@partner.example" });
    await h.engine.runLogAction(passed, "block");
    expect(entry(h, "domain", "partner.example")?.list).toBe("white");
    expect(entry(h, "address", "newsletter@partner.example")?.list).toBe("black");
  });

  it("moves the white address entry that decided to the black list, where it is", async () => {
    const h = await harness();
    h.state.addEntry({ list: "white", kind: "address", value: "sales@cold.example", scope: "account1", source: "manual" }, 1);
    const msg = h.mail.put(INBOX1, { author: "sales@cold.example" });
    const outcome = await h.engine.runLogAction(logged(msg, { outcome: "trusted", action: "none", reason: "white-address" }), "block");
    expect(outcome).toMatchObject({ change: "move", scope: "account1", target: { kind: "address", value: "sales@cold.example" } });
    expect(entry(h, "address", "sales@cold.example", "account1")?.list).toBe("black");
    // Nothing else was added: the entry itself changed its list.
    expect(h.state.entries.size).toBe(1);
  });

  it("changes nothing on the lists when a black entry decides already: only the message moves", async () => {
    const h = await harness();
    h.state.addEntry({ list: "black", kind: "address", value: "sales@cold.example", scope: "all", source: "manual" }, 1);
    const before = structuredClone([...h.state.entries.values()]);
    const msg = h.mail.put(INBOX1, { author: "sales@cold.example" });
    const outcome = await h.engine.runLogAction(logged(msg, { outcome: "passed", action: "none", reason: "ai-below" }), "block");
    expect(outcome).toMatchObject({ change: "none", move: "moved" });
    expect([...h.state.entries.values()]).toEqual(before);
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
  });

  it("leaves a message alone that the user has filed elsewhere", async () => {
    const h = await harness();
    const filed = h.mail.addFolder({ accountId: "account1", path: "/Projects" });
    const msg = h.mail.put(filed, { author: "sales@cold.example" });
    const outcome = await h.engine.runLogAction(logged(msg, { outcome: "passed", action: "none" }), "block");
    expect(outcome.move).toBe("not-found");
    expect(h.mail.ids(filed)).toEqual([msg.id]);
    expect(entry(h, "domain", "cold.example")?.list).toBe("black");
  });

  it("moves the message from a monitored folder the user added", async () => {
    const h = await harness();
    const rules = h.mail.addFolder({ accountId: "account1", path: "/Rules" });
    h.state.settings.monitoredFoldersAdded = [rules];
    const msg = h.mail.put(rules, { author: "sales@cold.example" });
    const outcome = await h.engine.runLogAction(logged(msg, { outcome: "passed", action: "none" }), "block");
    expect(outcome.move).toBe("moved");
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
  });

  it("reports an account without a Junk folder and keeps the entry", async () => {
    const h = await harness();
    h.mail.removeFolder(JUNK1);
    const msg = h.mail.put(INBOX1, { author: "sales@cold.example" });
    const outcome = await h.engine.runLogAction(logged(msg, { outcome: "passed", action: "none" }), "block");
    expect(outcome.move).toBe("no-folder");
    expect(entry(h, "domain", "cold.example")?.list).toBe("black");
    expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
  });
});

describe("log actions that are refused", () => {
  it("never acts on one of the user's own addresses", async () => {
    const h = await harness();
    const msg = h.mail.put(INBOX1, { author: "me@mycompany.example" });
    const attempt = h.engine.runLogAction(logged(msg, { outcome: "trusted", action: "none" }), "block");
    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt).rejects.toMatchObject({ code: "own-address" });
    expect(h.state.entries.size).toBe(0);
    expect(h.mail.moves).toEqual([]);
  });

  it("needs a sender", async () => {
    const h = await harness();
    const msg = h.mail.put(INBOX1, {});
    await expect(h.engine.runLogAction(logged(msg, { sender: "" }), "trust")).rejects.toMatchObject({ code: "no-sender" });
    expect(h.state.entries.size).toBe(0);
  });
});

describe("undo of a log action", () => {
  it("puts the entries back exactly as they were and the message where it came from", async () => {
    const h = await harness();
    h.state.addEntry({ list: "black", kind: "domain", value: "leadgen.example", scope: "all", source: "ai" }, 5);
    const before = structuredClone([...h.state.entries.values()]);
    const msg = h.mail.put(JUNK1, { author: "growth@leadgen.example" });
    const outcome = await h.engine.runLogAction(logged(msg, {}), "trust");
    expect(h.mail.ids(INBOX1)).toEqual([msg.id]);

    expect(await h.engine.undoLogAction(outcome.undo)).toEqual({ move: "moved", failure: "" });
    expect([...h.state.entries.values()]).toEqual(before);
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
    expect(h.mail.ids(INBOX1)).toEqual([]);
    expect([...(await reload(h.store)).entries.values()]).toEqual(before);
  });

  it("removes an entry that the action had added and restores what it had removed", async () => {
    const h = await harness();
    h.state.addEntry({ list: "white", kind: "address", value: "sales@cold.example", scope: "account1", source: "sent" }, 7);
    const before = structuredClone([...h.state.entries.values()]);
    const msg = h.mail.put(INBOX1, { author: "sales@cold.example" });
    const outcome = await h.engine.runLogAction(logged(msg, { outcome: "trusted", action: "none" }), "block");
    // The entry that decided was moved to the black list: Undo puts it back as it was, and has nothing to remove.
    expect(outcome.undo.remove).toEqual([]);
    expect(outcome.undo.restore).toEqual(before);

    await h.engine.undoLogAction(outcome.undo);
    expect([...h.state.entries.values()]).toEqual(before);
    expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
  });

  it("leaves an entry that already trusts the sender exactly as it is: the action is called Move to Inbox and only moves", async () => {
    const h = await harness();
    h.state.addEntry({ list: "white", kind: "domain", value: "partner.example", scope: "all", source: "scan" }, 3);
    const msg = h.mail.put(JUNK1, { author: "anna@partner.example" });
    const outcome = await h.engine.runLogAction(logged(msg, { outcome: "no-verdict", action: "junk" }), "trust");
    expect(outcome.change).toBe("none");
    expect(outcome.undo).toMatchObject({ remove: [], restore: [] });
    // Not even the source changes: a command never changes more than its label says.
    expect(entry(h, "domain", "partner.example")).toEqual({ list: "white", kind: "domain", value: "partner.example", scope: "all", source: "scan", addedAt: 3 });
    expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
  });

  it("changes nothing in the lists when the action had changed nothing", async () => {
    const h = await harness();
    h.state.addEntry({ list: "white", kind: "domain", value: "partner.example", scope: "all", source: "manual" }, 3);
    const msg = h.mail.put(JUNK1, { author: "anna@partner.example" });
    const outcome = await h.engine.runLogAction(logged(msg, { outcome: "no-verdict", action: "junk" }), "trust");
    expect(outcome.change).toBe("none");
    expect(outcome.undo).toMatchObject({ remove: [], restore: [] });
    await h.engine.undoLogAction(outcome.undo);
    expect(entry(h, "domain", "partner.example")?.list).toBe("white");
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
  });

  it("reports a message that has moved on since", async () => {
    const h = await harness();
    const msg = h.mail.put(JUNK1, { author: "growth@leadgen.example" });
    const outcome = await h.engine.runLogAction(logged(msg, {}), "trust");
    const filed = h.mail.addFolder({ accountId: "account1", path: "/Projects" });
    await h.mail.move([msg.id], filed);
    expect(await h.engine.undoLogAction(outcome.undo)).toEqual({ move: "not-found", failure: "" });
    expect(h.state.entries.size).toBe(0);
  });
});

describe("the sender a command would act on", () => {
  it("describes the sender of a message and what the domain commands would add", async () => {
    const h = await harness();
    const company = h.mail.put(INBOX1, { author: "Mike <mike@mail.outreach.example>" });
    const personal = h.mail.put(INBOX1, { author: "friend@gmail.com" });
    const own = h.mail.put(INBOX1, { author: "me@mycompany.example" });
    expect(await h.engine.describeSender(company)).toEqual({
      address: "mike@mail.outreach.example",
      via: "",
      own: false,
      domainTarget: { kind: "domain", value: "outreach.example" },
      deciding: null,
      accountId: "account1",
      messageId: company.headerMessageId,
      unchanged: [],
      effects: {
        "block-address": { target: { kind: "address", value: "mike@mail.outreach.example" }, change: "added", lifted: [], moves: true, kept: null },
        "block-domain": { target: { kind: "domain", value: "outreach.example" }, change: "added", lifted: [], moves: true, kept: null },
        "trust-address": { target: { kind: "address", value: "mike@mail.outreach.example" }, change: "added", lifted: [], moves: false, kept: null },
        "trust-domain": { target: { kind: "domain", value: "outreach.example" }, change: "added", lifted: [], moves: false, kept: null },
      },
    });
    expect((await h.engine.describeSender(personal)).domainTarget).toEqual({ kind: "address", value: "friend@gmail.com" });
    expect((await h.engine.describeSender(own)).own).toBe(true);
    h.state.settings.smart = false;
    expect((await h.engine.describeSender(personal)).domainTarget).toEqual({ kind: "domain", value: "gmail.com" });
  });

  it("names the original sender of a wrapped forward, or only the forwarding mailbox", async () => {
    const h = await harness();
    h.state.settings.forwardingMailboxes = ["office@partner.example"];
    h.state.refreshDerived();
    const known = h.mail.put(INBOX1, { author: "office@partner.example", headers: { "x-original-from": ["cold@outreach.example"] } });
    const unknown = h.mail.put(INBOX1, { author: "office@partner.example", body: "nothing useful" });
    expect(await h.engine.describeSender(known)).toMatchObject({ address: "cold@outreach.example", via: "office@partner.example" });
    expect(await h.engine.describeSender(unknown)).toEqual({
      address: "",
      via: "office@partner.example",
      own: false,
      domainTarget: null,
      deciding: null,
      accountId: "account1",
      messageId: unknown.headerMessageId,
      unchanged: [],
      effects: {},
    });
  });
});

describe("the label of a log action names exactly what it changes", () => {
  const sender = "news@partner.example";
  const row = (partial: Partial<LogEntry>): LogEntry =>
    logged({ accountId: "account1", author: sender, subject: "s", headerMessageId: "m@test" } as FakeMessage, { sender, ...partial });
  const blocked = row({ outcome: "blocked", action: "junk", reason: "black-address" });
  const spam = row({ outcome: "spam", action: "junk", reason: "ai-above" });
  const observed = row({ outcome: "spam", action: "junk", reason: "ai-above", observed: true });
  const passed = row({ outcome: "passed", action: "none", reason: "ai-below" });
  const trusted = row({ outcome: "trusted", action: "none", reason: "white-domain" });
  const add = (h: Harness, list: "white" | "black", kind: "address" | "domain", value: string, scope = "all"): void => {
    h.state.addEntry({ list, kind, value, scope, source: "manual" }, 1);
  };

  /** One line per case: the lists before, the row, and what its button says and does. */
  const cases: [name: string, setup: (h: Harness) => void, entry: LogEntry, label: string, title: string, change: string, target: string, result: string][] = [
    ["black address decides", (h) => add(h, "black", "address", sender), blocked, "trust-address", "trust-move", "move", sender, "moved-white"],
    ["black domain decides", (h) => add(h, "black", "domain", "partner.example"), spam, "trust-domain", "trust-move", "move", "partner.example", "moved-white"],
    ["black address inside a white domain", (h) => (add(h, "white", "domain", "partner.example"), add(h, "black", "address", sender)), blocked, "unblock-address", "unblock-move", "remove", sender, "unblocked"],
    ["black address of the account before a white address for all accounts", (h) => (add(h, "white", "address", sender), add(h, "black", "address", sender, "account1")), blocked, "unblock-address", "unblock-move", "remove", sender, "unblocked"],
    ["black domain of the account before a white domain for all accounts", (h) => (add(h, "white", "domain", "partner.example"), add(h, "black", "domain", "partner.example", "account1")), blocked, "unblock-domain", "unblock-move", "remove", "partner.example", "unblocked"],
    ["black address before a black domain", (h) => (add(h, "black", "domain", "partner.example"), add(h, "black", "address", sender)), blocked, "trust-address", "trust-move", "move", sender, "moved-white"],
    ["nothing decides after an observed verdict", () => undefined, observed, "trust-domain", "trust", "add", "partner.example", "trusted"],
    ["nothing decides any more after a move to Junk", () => undefined, spam, "trust-domain", "trust-move", "add", "partner.example", "trusted"],
    ["white entry decides, the message was moved", (h) => add(h, "white", "domain", "partner.example"), spam, "move-inbox", "move-inbox", "none", "partner.example", "already-trusted"],
    ["white entry decides, nothing was moved", (h) => add(h, "white", "domain", "partner.example"), observed, "trusted-now", "trusted-now", "none", "partner.example", "already-trusted"],
    ["a sender that passed, on neither list", () => undefined, passed, "block-domain", "block", "add", "partner.example", "blocked"],
    ["a sender that passed, black entry decides by now", (h) => add(h, "black", "domain", "partner.example"), passed, "move-junk", "move-junk", "none", "partner.example", "already-blocked"],
    ["white domain decides", (h) => add(h, "white", "domain", "partner.example"), trusted, "block-address", "block", "add", sender, "blocked"],
    ["white address decides", (h) => add(h, "white", "address", sender, "account1"), trusted, "block-address", "block", "move", sender, "moved-black"],
    ["white address inside a black domain", (h) => (add(h, "black", "domain", "partner.example"), add(h, "white", "address", sender)), trusted, "block-address", "block", "move", sender, "moved-black"],
    ["a trusted sender whose entry is gone", () => undefined, trusted, "block-address", "block", "add", sender, "blocked"],
  ];

  it.each(cases)("%s", async (_name, setup, logEntry, label, title, change, target, result) => {
    const h = await harness();
    setup(h);
    const action = fittingAction(logEntry);
    expect(action).not.toBeNull();
    const offer = offered(h, logEntry, action as "trust" | "block");
    expect(offer).not.toBeNull();
    if (offer === null || action === null) {
      return;
    }
    const said = logLabel(offer, expectsMove(logEntry, action));
    expect({ label: said.label, title: said.title, change: offer.change, target: offer.target.value }).toEqual({ label, title, change, target });
    // The label names the kind of entry it changes, and the tooltip its value.
    if (offer.change !== "none") {
      expect(said.label.endsWith(offer.target.kind)).toBe(true);
      expect(said.titleArgs[0]).toBe(offer.target.value);
    }

    // What the action really does is what the label said, and nothing else.
    const before = new Map([...h.state.entries].map(([key, value]) => [key, structuredClone(value)]));
    const message = h.mail.put(logEntry.action === "junk" && !logEntry.observed ? JUNK1 : INBOX1, { author: sender });
    const outcome = await h.engine.runLogAction({ ...logEntry, messageId: message.headerMessageId }, action);
    expect(outcome.change).toBe(change);
    expect(logResult(outcome).code).toBe(result);
    const changed = [...new Set([...before.keys(), ...h.state.entries.keys()])].filter((key) => JSON.stringify(before.get(key)) !== JSON.stringify(h.state.entries.get(key)));
    expect(changed).toEqual(change === "none" ? [] : [entryKey(offer.target.kind, offer.target.value, offer.scope)]);
    const now = h.state.entries.get(entryKey(offer.target.kind, offer.target.value, offer.scope));
    if (change === "remove") {
      expect(now).toBeUndefined();
    } else if (change !== "none") {
      expect(now).toMatchObject({ list: offer.list, source: "manual" });
    }
    // The action takes effect: the sender is decided the way the label said.
    const said2 = offered(h, logEntry, action);
    expect(said2?.change).toBe("none");

    // Undo restores the lists exactly.
    await h.engine.undoLogAction(outcome.undo);
    expect(new Map(h.state.entries)).toEqual(before);
    // The line under the decision then says what is true again: the list the entry is back on, or that it is on neither.
    const was = before.get(entryKey(offer.target.kind, offer.target.value, offer.scope));
    const back = logUndone(outcome);
    expect(back?.code ?? null).toBe(change === "none" ? null : was === undefined ? "neither-again" : `${was.list}-again`);
    if (back !== null) {
      expect(back.args).toEqual([offer.target.value]);
    }
  });

  it("says where the message is after Undo moved it back, by the kind of folder", () => {
    expect(backPlace(["junk"])).toBe("junk");
    expect(backPlace(["inbox"])).toBe("inbox");
    // A screening folder, or another monitored folder, is named.
    expect(backPlace([])).toBe("folder");
    expect(backPlace(["archives"])).toBe("folder");
  });
});
