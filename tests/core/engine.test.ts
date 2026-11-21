import { describe, expect, it } from "vitest";
import { receivedTime, WINDOW_MS } from "../../src/core/engine";
import type { ScanProgress } from "../../src/core/engine";
import { entryKey } from "../../src/core/lists";
import { Engine } from "../../src/core/engine";
import { reload } from "../helpers/fakes";
import { accessPoint, DAY, harness, HOUR, INBOX1, INBOX2, JUNK1, SCREEN1, SENT1, SENT2, unauthorized } from "../helpers/harness";
import type { Harness } from "../helpers/harness";

const MINUTE = 60 * 1000;

async function pages<T>(items: T[]): Promise<AsyncIterable<T[]>> {
  return (async function* () {
    yield items;
  })();
}

describe("tick", () => {
  it("adds identity entries, records the tick and runs whether protection is on or off", async () => {
    const h = await harness();
    await h.engine.tick();
    expect(h.state.entries.get(entryKey("domain", "mycompany.example", "all"))).toMatchObject({ list: "white", source: "identity" });
    expect(h.state.entries.get(entryKey("address", "me@gmail.com", "all"))).toMatchObject({ list: "white", source: "identity" });
    expect(h.state.lastTick).toBe(h.clock.now);
    expect((await reload(h.store)).lastTick).toBe(h.clock.now);
  });

  it("does not handle incoming mail while protection is off", async () => {
    const h = await harness();
    h.state.accessPoints = [accessPoint()];
    h.state.addEntry({ list: "black", kind: "domain", value: "blocked.example", scope: "all", source: "manual" }, 1);
    const msg = h.mail.put(INBOX1, { author: "a@blocked.example", date: h.clock.now + MINUTE });
    h.clock.now += 5 * MINUTE;
    await h.engine.tick();
    expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
    expect(h.log()).toEqual([]);
  });

  it("never handles mail dated before protection was switched on", async () => {
    const h = await harness();
    await h.engine.tick();
    h.state.addEntry({ list: "black", kind: "domain", value: "blocked.example", scope: "all", source: "manual" }, 1);
    const before = h.mail.put(INBOX1, { author: "a@blocked.example", date: h.clock.now - HOUR });
    h.clock.now += HOUR;
    h.protect();
    const after = h.mail.put(INBOX1, { author: "b@blocked.example", date: h.clock.now + MINUTE });
    h.clock.now += 5 * MINUTE;
    await h.engine.tick();
    expect(h.mail.ids(INBOX1)).toEqual([before.id]);
    expect(h.mail.ids(JUNK1)).toEqual([after.id]);
  });

  it("handles mail from the very second protection was switched on", async () => {
    const h = await harness();
    await h.engine.tick();
    h.state.addEntry({ list: "black", kind: "domain", value: "blocked.example", scope: "all", source: "manual" }, 1);
    h.clock.now += HOUR;
    h.protect();
    // Mail dates have whole seconds; protection was switched on 400 ms into this one.
    const second = Math.floor(h.clock.now / 1000) * 1000;
    h.state.settings.protectionOnAt = second + 400;
    const before = h.mail.put(INBOX1, { author: "a@blocked.example", date: second - 1000 });
    const same = h.mail.put(INBOX1, { author: "b@blocked.example", date: second });
    h.clock.now += 5 * MINUTE;
    await h.engine.tick();
    expect(h.mail.ids(INBOX1)).toEqual([before.id]);
    expect(h.mail.ids(JUNK1)).toEqual([same.id]);
  });

  it("is idempotent: a message is handled once", async () => {
    const h = await harness();
    h.protect();
    h.state.accessPoints = [accessPoint()];
    h.mail.put(INBOX1, { author: "x@prospect.example", date: h.clock.now + MINUTE });
    h.clock.now += 5 * MINUTE;
    await h.engine.tick();
    h.clock.now += 5 * MINUTE;
    await h.engine.tick();
    await h.engine.tick();
    expect(h.ai.calls).toHaveLength(1);
    expect(h.log()).toHaveLength(1);
  });

  it("catches up after downtime, 48 hours back from the previous tick", async () => {
    const h = await harness();
    h.protect();
    h.state.settings.protectionOnAt = h.clock.now - 10 * DAY;
    await h.engine.tick();
    const lastTick = h.clock.now;
    h.state.addEntry({ list: "black", kind: "domain", value: "blocked.example", scope: "all", source: "manual" }, 1);
    // Thunderbird was closed for five days. Mail arrived meanwhile and was read on a phone.
    const during = h.mail.put(INBOX1, { author: "a@blocked.example", date: lastTick + 2 * DAY });
    const lateArrival = h.mail.put(INBOX1, { author: "b@blocked.example", date: lastTick - WINDOW_MS + HOUR });
    const tooOld = h.mail.put(INBOX1, { author: "c@blocked.example", date: lastTick - WINDOW_MS - HOUR });
    h.clock.now = lastTick + 5 * DAY;
    await h.engine.tick();
    expect(h.mail.ids(JUNK1).sort()).toEqual([during.id, lateArrival.id].sort());
    expect(h.mail.ids(INBOX1)).toEqual([tooOld.id]);
  });

  it("judges a message that reuses the Message-ID of one already handled, and a copy only once", async () => {
    const h = await harness();
    h.protect();
    h.state.accessPoints = [accessPoint()];
    h.state.addEntry({ list: "black", kind: "domain", value: "blocked.example", scope: "all", source: "manual" }, 1);
    const projects = h.mail.addFolder({ accountId: "account1", path: "/Projects" });
    h.state.settings.monitoredFoldersAdded = [projects];
    const date = h.clock.now + MINUTE;
    h.mail.put(INBOX1, { author: "a@one.example", headerMessageId: "reused@x", date });
    const spam = h.mail.put(INBOX1, { author: "spam@blocked.example", headerMessageId: "reused@x", date: date + 1 });
    // A copy rule put the first message into a second monitored folder as well.
    h.mail.put(projects, { author: "a@one.example", headerMessageId: "reused@x", date });
    h.clock.now += 5 * MINUTE;
    await h.engine.tick();
    expect(h.mail.ids(JUNK1)).toEqual([spam.id]);
    expect(h.ai.calls).toHaveLength(1);
    expect(h.log().map((entry) => entry.sender)).toEqual(["a@one.example", "spam@blocked.example"]);
  });

  it("handles a message again after an interrupted run, because only finished messages are recorded", async () => {
    const h = await harness();
    h.protect();
    await h.state.saveSettings();
    h.state.accessPoints = [accessPoint()];
    h.mail.put(INBOX1, { author: "x@prospect.example", date: h.clock.now + MINUTE });
    h.clock.now += 5 * MINUTE;
    // The background page is unloaded while the AI is working: the score never arrives.
    const interrupted = new Engine({ state: h.state, mail: h.mail, ai: { score: () => new Promise(() => undefined) }, now: () => h.clock.now });
    void interrupted.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const restarted = await reload(h.store);
    restarted.accessPoints = [accessPoint()];
    h.ai.replies["*"] = 0.2;
    const engine = new Engine({ state: restarted, mail: h.mail, ai: h.ai, now: () => h.clock.now });
    await engine.tick();
    expect(h.ai.calls).toHaveLength(1);
    await engine.tick();
    expect(h.ai.calls).toHaveLength(1);
  });

  it("monitors the Inbox of every account and added folders only", async () => {
    const h = await harness();
    h.protect();
    const projects = h.mail.addFolder({ accountId: "account1", path: "/Projects" });
    const other = h.mail.addFolder({ accountId: "account1", path: "/Other" });
    h.state.settings.monitoredFoldersAdded = [projects];
    h.state.addEntry({ list: "black", kind: "domain", value: "blocked.example", scope: "all", source: "manual" }, 1);
    const date = h.clock.now + MINUTE;
    const a = h.mail.put(INBOX1, { author: "a@blocked.example", date });
    const b = h.mail.put(INBOX2, { author: "b@blocked.example", date });
    const c = h.mail.put(projects, { author: "c@blocked.example", date });
    const d = h.mail.put(other, { author: "d@blocked.example", date });
    h.clock.now += 5 * MINUTE;
    await h.engine.tick();
    expect(h.mail.ids(JUNK1).sort()).toEqual([a.id, c.id].sort());
    expect(h.mail.ids({ accountId: "account2", path: "/Junk" })).toEqual([b.id]);
    expect(h.mail.ids(other)).toEqual([d.id]);
  });

  it("keeps going when a folder cannot be read", async () => {
    const h = await harness();
    h.protect();
    h.state.settings.monitoredFoldersAdded = [{ accountId: "account1", path: "/Deleted" }];
    h.state.addEntry({ list: "black", kind: "domain", value: "blocked.example", scope: "all", source: "manual" }, 1);
    const msg = h.mail.put(INBOX2, { author: "b@blocked.example", date: h.clock.now + MINUTE });
    h.clock.now += 5 * MINUTE;
    await h.engine.tick();
    expect(h.mail.ids({ accountId: "account2", path: "/Junk" })).toEqual([msg.id]);
    expect(h.warnings.some((warning) => warning.includes("/Deleted"))).toBe(true);
    expect(h.state.lastTick).toBe(h.clock.now);
  });

  it("prunes processed buckets after a completed tick", async () => {
    const h = await harness();
    await h.state.markProcessed("in", "account1 old@x", h.clock.now - 40 * DAY, 0);
    await h.engine.tick();
    expect(h.state.isProcessed("in", "account1 old@x")).toBe(false);
  });

  it("does not expire the record of a message dated in the future", async () => {
    const h = await harness();
    h.protect();
    h.state.accessPoints = [accessPoint()];
    h.mail.put(INBOX1, { author: "x@prospect.example", date: h.clock.now + 365 * DAY });
    for (let day = 0; day < 45; day += 1) {
      h.clock.now += DAY;
      await h.engine.tick();
    }
    expect(h.ai.calls).toHaveLength(1);
  });
});

describe("fast path for new mail", () => {
  async function ready(): Promise<Harness> {
    const h = await harness();
    h.protect();
    h.state.addEntry({ list: "black", kind: "domain", value: "blocked.example", scope: "all", source: "manual" }, 1);
    return h;
  }

  it("handles new mail in a monitored folder at once", async () => {
    const h = await ready();
    const msg = h.mail.put(INBOX1, { author: "a@blocked.example", date: h.clock.now + MINUTE });
    await h.engine.handleNewMail(INBOX1, await pages([msg]));
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
    await h.engine.tick();
    expect(h.log()).toHaveLength(1);
  });

  it("ignores folders that are not monitored, and everything while protection is off", async () => {
    const h = await ready();
    const other = h.mail.addFolder({ accountId: "account1", path: "/Other" });
    const msg = h.mail.put(other, { author: "a@blocked.example", date: h.clock.now + MINUTE });
    await h.engine.handleNewMail(other, await pages([msg]));
    expect(h.mail.ids(other)).toEqual([msg.id]);

    h.state.settings.protection = false;
    const inbox = h.mail.put(INBOX1, { author: "a@blocked.example", date: h.clock.now + MINUTE });
    await h.engine.handleNewMail(INBOX1, await pages([inbox]));
    expect(h.mail.ids(INBOX1)).toEqual([inbox.id]);
  });

  it("handles backdated mail that arrived after protection was switched on, by its Received header", async () => {
    const h = await ready();
    const arrival = new Date(h.clock.now + MINUTE).toUTCString();
    const backdated = h.mail.put(INBOX1, {
      author: "a@blocked.example",
      date: Date.UTC(2020, 0, 1),
      headers: { received: [`from mx.outreach.example by mx.mycompany.example; ${arrival}`, "from a by b; Wed, 1 Jan 2020 00:00:00 +0000"] },
    });
    const old = h.mail.put(INBOX1, {
      author: "b@blocked.example",
      date: Date.UTC(2020, 0, 1),
      headers: { received: ["by mx.mycompany.example; Wed, 01 Jan 2020 00:00:05 +0000 (UTC)"] },
    });
    const unknown = h.mail.put(INBOX1, { author: "c@blocked.example", date: Date.UTC(2020, 0, 1) });
    h.clock.now += 2 * MINUTE;
    await h.engine.handleNewMail(INBOX1, await pages([backdated, old, unknown]));
    expect(h.mail.ids(JUNK1)).toEqual([backdated.id]);
    expect(h.mail.ids(INBOX1)).toEqual([old.id, unknown.id]);
    expect(h.log()).toMatchObject([{ outcome: "blocked", sender: "a@blocked.example" }]);
  });

  it("handles new mail from the very second protection was switched on", async () => {
    const h = await ready();
    const second = Math.floor(h.clock.now / 1000) * 1000;
    h.state.settings.protectionOnAt = second + 400;
    const before = h.mail.put(INBOX1, { author: "a@blocked.example", date: second - 1000 });
    const same = h.mail.put(INBOX1, { author: "b@blocked.example", date: second });
    const arrival = new Date(second).toUTCString();
    const backdated = h.mail.put(INBOX1, {
      author: "c@blocked.example",
      date: Date.UTC(2020, 0, 1),
      headers: { received: [`from mx.outreach.example by mx.mycompany.example; ${arrival}`] },
    });
    await h.engine.handleNewMail(INBOX1, await pages([before, same, backdated]));
    expect(h.mail.ids(INBOX1)).toEqual([before.id]);
    expect(h.mail.ids(JUNK1)).toEqual([same.id, backdated.id]);
  });

  it("reads the arrival time of a Received header", () => {
    expect(receivedTime("from a by b with ESMTPS id x; Tue, 24 Nov 2026 12:00:00 +0100 (CET)")).toBe(Date.UTC(2026, 10, 24, 11));
    expect(receivedTime("from a by b")).toBe(0);
    expect(receivedTime("by b; not a date")).toBe(0);
  });

  it("skips mail dated before protection was switched on, but handles late arrivals after it", async () => {
    const h = await ready();
    const old = h.mail.put(INBOX1, { author: "a@blocked.example", date: h.clock.now - DAY });
    h.clock.now += 10 * DAY;
    await h.engine.tick();
    const delayed = h.mail.put(INBOX1, { author: "b@blocked.example", date: h.clock.now - 5 * DAY });
    await h.engine.handleNewMail(INBOX1, await pages([old, delayed]));
    expect(h.mail.ids(INBOX1)).toEqual([old.id]);
    expect(h.mail.ids(JUNK1)).toEqual([delayed.id]);
  });
});

describe("learning from sent mail", () => {
  it("learns recipients of messages sent after installation, from To, Cc and Bcc", async () => {
    const h = await harness();
    h.mail.put(SENT1, {
      author: "me@mycompany.example",
      recipients: ["Anna <anna@customer.example>", "me@mycompany.example"],
      ccList: ["friend@gmail.com"],
      bccList: ["Boss <boss@partner.example>"],
      date: h.clock.now + MINUTE,
    });
    h.clock.now += 5 * MINUTE;
    await h.engine.tick();
    expect(h.state.entries.get(entryKey("domain", "customer.example", "all"))).toMatchObject({ list: "white", source: "sent" });
    expect(h.state.entries.get(entryKey("address", "friend@gmail.com", "all"))?.list).toBe("white");
    expect(h.state.entries.get(entryKey("domain", "partner.example", "all"))?.list).toBe("white");
    expect((await reload(h.store)).entries.size).toBe(h.state.entries.size);
  });

  it("leaves older sent mail to the manual scan", async () => {
    const h = await harness();
    h.mail.put(SENT1, { recipients: ["old@history.example"], date: h.clock.now - HOUR });
    h.clock.now += 5 * MINUTE;
    await h.engine.tick();
    expect(h.state.entries.has(entryKey("domain", "history.example", "all"))).toBe(false);
  });

  it("learns each sent message once", async () => {
    const h = await harness();
    h.mail.put(SENT1, { recipients: ["anna@customer.example"], date: h.clock.now + MINUTE });
    h.clock.now += 5 * MINUTE;
    await h.engine.tick();
    h.state.removeEntry(entryKey("domain", "customer.example", "all"));
    h.clock.now += 5 * MINUTE;
    await h.engine.tick();
    expect(h.state.entries.has(entryKey("domain", "customer.example", "all"))).toBe(false);
  });

  it("catches mail sent from a phone while Thunderbird was closed", async () => {
    const h = await harness();
    await h.engine.tick();
    h.mail.put(SENT1, { recipients: ["anna@customer.example"], date: h.clock.now + 2 * DAY });
    h.clock.now += 4 * DAY;
    await h.engine.tick();
    expect(h.state.entries.has(entryKey("domain", "customer.example", "all"))).toBe(true);
  });

  it("uses the account of the Sent folder as scope when new entries are per account", async () => {
    const h = await harness();
    h.state.settings.newEntryScope = "account";
    h.mail.put(SENT2, { recipients: ["anna@customer.example"], date: h.clock.now + MINUTE });
    h.clock.now += 5 * MINUTE;
    await h.engine.tick();
    expect(h.state.entries.has(entryKey("domain", "customer.example", "account2"))).toBe(true);
  });

  it("follows the user's Sent folder choices", async () => {
    const h = await harness();
    const archive = h.mail.addFolder({ accountId: "account1", path: "/Sent/Clients" });
    h.state.settings.sentFoldersAdded = [archive];
    h.state.settings.sentFoldersRemoved = [SENT2];
    h.mail.put(archive, { recipients: ["a@clients.example"], date: h.clock.now + MINUTE });
    h.mail.put(SENT2, { recipients: ["b@ignored.example"], date: h.clock.now + MINUTE });
    h.clock.now += 5 * MINUTE;
    await h.engine.tick();
    expect(h.state.entries.has(entryKey("domain", "clients.example", "all"))).toBe(true);
    expect(h.state.entries.has(entryKey("domain", "ignored.example", "all"))).toBe(false);
  });

  it("learns at once from a live send, in observation mode and with protection off", async () => {
    const h = await harness();
    h.state.settings.observation = true;
    await h.engine.learnFromSend("account1", ["Anna <anna@customer.example>, b@gmail.com", "me@mycompany.example"]);
    expect(h.state.entries.get(entryKey("domain", "customer.example", "all"))).toMatchObject({ list: "white", source: "sent" });
    expect(h.state.entries.get(entryKey("address", "b@gmail.com", "all"))?.list).toBe("white");
    expect(h.state.entries.size).toBe(2);
    expect((await reload(h.store)).entries.size).toBe(2);
  });

  it("never overrides a manual block and replaces an AI block", async () => {
    const h = await harness();
    h.state.addEntry({ list: "black", kind: "domain", value: "manual.example", scope: "all", source: "manual" }, 1);
    h.state.addEntry({ list: "black", kind: "domain", value: "ai.example", scope: "all", source: "ai" }, 1);
    await h.engine.learnFromSend("account1", ["a@manual.example", "b@ai.example"]);
    expect(h.state.entries.get(entryKey("domain", "manual.example", "all"))).toMatchObject({ list: "black", source: "manual" });
    expect(h.state.entries.get(entryKey("domain", "ai.example", "all"))).toMatchObject({ list: "white", source: "sent" });
  });
});

describe("screening sweep", () => {
  async function screening(): Promise<Harness> {
    const h = await harness();
    h.mail.addFolder(SCREEN1);
    h.state.settings.screeningFolders = [SCREEN1];
    return h;
  }

  it("moves messages from newly whitelisted senders to the Inbox of their account", async () => {
    const h = await screening();
    const anna = h.mail.put(SCREEN1, { author: "Anna <anna@customer.example>" });
    const other = h.mail.put(SCREEN1, { author: "x@unknown.example" });
    await h.engine.learnFromSend("account1", ["sales@customer.example"]);
    expect(h.mail.ids(INBOX1)).toEqual([anna.id]);
    expect(h.mail.ids(SCREEN1)).toEqual([other.id]);
    expect(h.log()).toMatchObject([
      { outcome: "released", action: "inbox", reason: "whitelisted", sender: "anna@customer.example", detail: "customer.example [all]" },
    ]);
    expect(h.state.whiteAdded).toBe(false);
  });

  it("runs after the Sent folder watch added an entry", async () => {
    const h = await screening();
    const anna = h.mail.put(SCREEN1, { author: "anna@customer.example" });
    h.mail.put(SENT1, { recipients: ["anna@customer.example"], date: h.clock.now + MINUTE });
    h.clock.now += 5 * MINUTE;
    await h.engine.tick();
    expect(h.mail.ids(INBOX1)).toEqual([anna.id]);
  });

  it("leaves a blocked address in screening even inside a trusted domain", async () => {
    const h = await screening();
    h.state.addEntry({ list: "black", kind: "address", value: "news@customer.example", scope: "all", source: "manual" }, 1);
    const news = h.mail.put(SCREEN1, { author: "news@customer.example" });
    await h.engine.learnFromSend("account1", ["anna@customer.example"]);
    expect(h.mail.ids(SCREEN1)).toEqual([news.id]);
  });

  it("does nothing without a white list change", async () => {
    const h = await screening();
    h.state.addEntry({ list: "white", kind: "domain", value: "customer.example", scope: "all", source: "sent" }, 1);
    h.state.whiteAdded = false;
    const anna = h.mail.put(SCREEN1, { author: "anna@customer.example" });
    await h.engine.tick();
    // The identity entries of the first tick trigger one sweep.
    expect(h.mail.ids(INBOX1)).toEqual([anna.id]);
    const later = h.mail.put(SCREEN1, { author: "anna@customer.example" });
    h.clock.now += 5 * MINUTE;
    await h.engine.tick();
    expect(h.mail.ids(SCREEN1)).toEqual([later.id]);
  });

  it("checks the screening folders at startup also without a new white list entry", async () => {
    const h = await screening();
    await h.engine.tick();
    // An entry stored just before Thunderbird closed, whose sweep never ran.
    h.state.addEntry({ list: "white", kind: "domain", value: "customer.example", scope: "all", source: "sent" }, 1);
    h.state.whiteAdded = false;
    const anna = h.mail.put(SCREEN1, { author: "anna@customer.example" });
    h.clock.now += 5 * MINUTE;
    await h.engine.tick();
    expect(h.mail.ids(SCREEN1)).toEqual([anna.id]);
    await h.engine.tick({ sweep: true });
    expect(h.mail.ids(INBOX1)).toEqual([anna.id]);
  });

  it("logs a failed move and leaves the message in screening", async () => {
    const h = await screening();
    const anna = h.mail.put(SCREEN1, { author: "anna@customer.example" });
    h.mail.failMoves = true;
    await h.engine.learnFromSend("account1", ["anna@customer.example"]);
    expect(h.mail.ids(SCREEN1)).toEqual([anna.id]);
    expect(h.log()).toMatchObject([{ outcome: "released", action: "none", reason: "move-failed" }]);
  });
});

describe("manual scan", () => {
  function collect(): { progress: ScanProgress[]; onProgress: (progress: ScanProgress) => void } {
    const progress: ScanProgress[] = [];
    return { progress, onProgress: (item) => progress.push(item) };
  }

  it("scans every configured Sent folder, old mail included, with counts", async () => {
    const h = await harness();
    h.mail.put(SENT1, { recipients: ["a@one.example"], date: h.clock.now - 400 * DAY });
    h.mail.put(SENT1, { recipients: ["b@two.example", "c@two.example"], date: h.clock.now - 30 * DAY });
    h.mail.put(SENT1, { recipients: ["me@mycompany.example"], date: h.clock.now - 10 * DAY });
    h.mail.put(SENT2, { recipients: ["d@gmail.com"], date: h.clock.now - DAY });
    const { progress, onProgress } = collect();
    const result = await h.engine.scan({ from: null, to: null }, onProgress, () => false);
    expect(result).toMatchObject({ running: false, cancelled: false, folderCount: 2, scanned: 4, added: 3, errors: [] });
    expect(h.state.entries.get(entryKey("domain", "one.example", "all"))).toMatchObject({ list: "white", source: "scan" });
    expect(h.state.entries.get(entryKey("address", "d@gmail.com", "all"))?.source).toBe("scan");
    expect(progress[0]).toMatchObject({ running: true, scanned: 0 });
    expect(progress.at(-1)).toMatchObject({ running: false, scanned: 4 });
    expect((await reload(h.store)).entries.size).toBe(3);
  });

  it("says how many messages it will read when the folders tell, so that the progress can be drawn", async () => {
    const h = await harness();
    h.mail.put(SENT1, { recipients: ["a@one.example"] });
    h.mail.put(SENT1, { recipients: ["b@two.example"] });
    h.mail.put(SENT2, { recipients: ["d@gmail.com"] });
    const { progress, onProgress } = collect();
    const result = await h.engine.scan({ from: null, to: null }, onProgress, () => false);
    expect(result.total).toBe(3);
    // The first report comes before the folders were asked.
    expect(progress[0]?.total).toBeNull();
    expect(progress[1]).toMatchObject({ total: 3, scanned: 0 });
  });

  it("does not guess the total for a date range, or when a folder does not tell its size", async () => {
    const h = await harness();
    h.mail.put(SENT1, { recipients: ["a@one.example"], date: h.clock.now - DAY });
    expect((await h.engine.scan({ from: h.clock.now - 2 * DAY, to: null }, () => undefined, () => false)).total).toBeNull();
    h.mail.countsKnown = false;
    expect((await h.engine.scan({ from: null, to: null }, () => undefined, () => false)).total).toBeNull();
  });

  it("limits the scan to a date range", async () => {
    const h = await harness();
    const start = h.clock.now - 20 * DAY;
    const end = h.clock.now - 10 * DAY;
    h.mail.put(SENT1, { recipients: ["a@before.example"], date: start - DAY });
    h.mail.put(SENT1, { recipients: ["b@inside.example"], date: start + DAY });
    h.mail.put(SENT1, { recipients: ["c@after.example"], date: end + DAY });
    await h.engine.scan({ from: start, to: end }, () => undefined, () => false);
    expect([...h.state.entries.values()].map((entry) => entry.value)).toEqual(["inside.example"]);

    await h.engine.scan({ from: null, to: start }, () => undefined, () => false);
    expect(h.state.entries.has(entryKey("domain", "before.example", "all"))).toBe(true);
    expect(h.state.entries.has(entryKey("domain", "after.example", "all"))).toBe(false);

    await h.engine.scan({ from: end, to: null }, () => undefined, () => false);
    expect(h.state.entries.has(entryKey("domain", "after.example", "all"))).toBe(true);
  });

  it("ignores the processed set, so running it again is harmless", async () => {
    const h = await harness();
    h.mail.put(SENT1, { recipients: ["a@one.example"], date: h.clock.now + MINUTE });
    h.clock.now += 5 * MINUTE;
    await h.engine.tick();
    h.state.removeEntry(entryKey("domain", "one.example", "all"));
    const first = await h.engine.scan({ from: null, to: null }, () => undefined, () => false);
    const second = await h.engine.scan({ from: null, to: null }, () => undefined, () => false);
    expect(first.added).toBe(1);
    expect(second.added).toBe(0);
    expect(h.state.entries.get(entryKey("domain", "one.example", "all"))?.source).toBe("scan");
  });

  it("keeps the entries learned before a cancel", async () => {
    const h = await harness();
    for (let index = 0; index < 10; index += 1) {
      h.mail.put(SENT1, { recipients: [`a@domain${index}.example`], date: h.clock.now - index * DAY });
    }
    let scanned = 0;
    const result = await h.engine.scan(
      { from: null, to: null },
      (progress) => {
        scanned = progress.scanned;
      },
      () => scanned >= 4,
    );
    expect(result.cancelled).toBe(true);
    expect(result.scanned).toBe(4);
    expect(h.state.entries.size).toBe(4);
    expect((await reload(h.store)).entries.size).toBe(4);
  });

  it("runs the screening sweep once, at the end", async () => {
    const h = await harness();
    h.mail.addFolder(SCREEN1);
    h.state.settings.screeningFolders = [SCREEN1];
    const waiting = h.mail.put(SCREEN1, { author: "a@one.example" });
    h.mail.put(SENT1, { recipients: ["a@one.example"], date: h.clock.now - 5 * DAY });
    h.mail.put(SENT1, { recipients: ["b@two.example"], date: h.clock.now - 4 * DAY });
    h.mail.put(SENT1, { recipients: ["c@three.example"], date: h.clock.now - 3 * DAY });
    await h.engine.scan({ from: null, to: null }, () => undefined, () => false);
    expect(h.mail.ids(INBOX1)).toEqual([waiting.id]);
    expect(h.mail.moves).toHaveLength(1);
  });

  it("parses each distinct recipient value once", async () => {
    const h = await harness();
    for (let index = 0; index < 30; index += 1) {
      h.mail.put(SENT1, { recipients: ["Anna <anna@customer.example>"], ccList: index % 2 === 0 ? ["bob@partner.example"] : [], date: h.clock.now - index * DAY });
    }
    const result = await h.engine.scan({ from: null, to: null }, () => undefined, () => false);
    expect(result).toMatchObject({ scanned: 30, added: 2 });
    expect(h.mail.parseCalls).toBe(2);
  });

  it("reports a folder that cannot be read and continues", async () => {
    const h = await harness();
    h.state.settings.sentFoldersAdded = [{ accountId: "account1", path: "/Gone" }];
    h.mail.put(SENT2, { recipients: ["a@one.example"], date: h.clock.now - DAY });
    const result = await h.engine.scan({ from: null, to: null }, () => undefined, () => false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("/Gone");
    expect(result.added).toBe(1);
  });
});

describe("test tools", () => {
  it("scores selected messages regardless of the lists, moving nothing and creating no entries", async () => {
    const h = await harness();
    h.state.accessPoints = [accessPoint()];
    h.state.addEntry({ list: "white", kind: "domain", value: "customer.example", scope: "all", source: "sent" }, 1);
    h.ai.replies["*"] = (_point, payload) => (payload.includes("customer.example") ? 0.1 : 0.95);
    const trusted = h.mail.put(INBOX1, { author: "anna@customer.example" });
    const unknown = h.mail.put(INBOX1, { author: "cold@outreach.example" });
    const before = h.state.entries.size;
    const summary = await h.engine.scoreSelected([trusted, unknown]);
    expect(summary).toEqual({ scored: 2, failed: 0 });
    expect(h.mail.moves).toHaveLength(0);
    expect(h.state.entries.size).toBe(before);
    expect(h.log()).toMatchObject([
      { test: true, outcome: "passed", score: 0.1, action: "none", sender: "anna@customer.example", accessPoint: "Primary" },
      { test: true, outcome: "spam", score: 0.95, action: "none", sender: "cold@outreach.example" },
    ]);
  });

  it("logs a test without a verdict", async () => {
    const h = await harness();
    const msg = h.mail.put(INBOX1, { author: "cold@outreach.example" });
    expect(await h.engine.scoreSelected([msg])).toEqual({ scored: 0, failed: 1 });
    expect(h.log()).toMatchObject([{ test: true, outcome: "no-verdict", reason: "no-ai" }]);

    h.state.accessPoints = [accessPoint()];
    h.ai.replies["*"] = unauthorized();
    await h.engine.scoreSelected([msg]);
    expect(h.log()[1]).toMatchObject({ test: true, outcome: "no-verdict", reason: "ai-failed", detail: "Primary: HTTP 401" });
  });

  it("tests one access point with the built-in sample email", async () => {
    const h = await harness();
    const point = accessPoint({ needsAttention: true, cooldownUntil: 99, lastError: "HTTP 401" });
    h.state.accessPoints = [point];
    h.ai.replies["*"] = 0.97;
    expect(await h.engine.testAccessPoint(point)).toEqual({ ok: true, score: 0.97 });
    expect(h.ai.calls[0]?.payload).toContain("Subject: Quick question about your website traffic");
    expect(point).toMatchObject({ needsAttention: false, cooldownUntil: 0, lastError: "" });

    h.ai.replies["*"] = unauthorized();
    expect(await h.engine.testAccessPoint(point)).toEqual({ ok: false, error: "HTTP 401" });
  });
});
