import { describe, expect, it } from "vitest";
import { entryKey } from "../../src/core/lists";
import { BODY_LIMIT, MAX_BODY_MESSAGE_SIZE } from "../../src/core/payload";
import { KEY_ENTRIES } from "../../src/core/state";
import type { Entry } from "../../src/core/types";
import { accessPoint, harness, HOUR, INBOX1, INBOX2, JUNK1, quota, SCREEN1, transient } from "../helpers/harness";
import type { Harness } from "../helpers/harness";

/** A harness with protection on and one message in the Work inbox, dated after protection was switched on. */
async function protectedHarness(): Promise<Harness> {
  const h = await harness();
  h.protect();
  h.clock.now += HOUR;
  return h;
}

function arrived(h: Harness): number {
  return h.clock.now - 10 * 60 * 1000;
}

describe("decision for one message", () => {
  it("leaves a white list match where it is, without AI", async () => {
    const h = await protectedHarness();
    h.state.accessPoints = [accessPoint()];
    h.state.addEntry({ list: "white", kind: "domain", value: "customer.example", scope: "all", source: "sent" }, 1);
    const msg = h.mail.put(INBOX1, { author: "Anna <anna@customer.example>", date: arrived(h) });
    await h.engine.tick();
    expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
    expect(h.ai.calls).toHaveLength(0);
    expect(h.log()).toMatchObject([
      { outcome: "trusted", action: "none", reason: "white-domain", detail: "customer.example [all]", sender: "anna@customer.example", account: "Work", observed: false, test: false },
    ]);
  });

  it("moves a black list match to the account's Junk folder", async () => {
    const h = await protectedHarness();
    h.state.addEntry({ list: "black", kind: "address", value: "cold@outreach.example", scope: "all", source: "manual" }, 1);
    const msg = h.mail.put(INBOX1, { author: "cold@outreach.example", date: arrived(h) });
    await h.engine.tick();
    expect(h.mail.ids(INBOX1)).toEqual([]);
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
    expect(h.log()).toMatchObject([{ outcome: "blocked", action: "junk", reason: "black-address" }]);
  });

  it("blacklists the smart target and moves the message when the score is above the cutoff", async () => {
    const h = await protectedHarness();
    h.state.accessPoints = [accessPoint()];
    h.ai.replies["*"] = 0.93;
    const company = h.mail.put(INBOX1, { author: "Mike <mike@mail.outreach.example>", date: arrived(h) });
    const personal = h.mail.put(INBOX1, { author: "spammer@gmail.com", date: arrived(h) });
    await h.engine.tick();
    expect(h.mail.ids(JUNK1).sort()).toEqual([company.id, personal.id].sort());
    expect(h.state.entries.get(entryKey("domain", "outreach.example", "all"))).toMatchObject({ list: "black", source: "ai" });
    expect(h.state.entries.get(entryKey("address", "spammer@gmail.com", "all"))).toMatchObject({ list: "black", source: "ai" });
    expect(h.log()[0]).toMatchObject({ outcome: "spam", action: "junk", score: 0.93, accessPoint: "Primary", reason: "ai-above", detail: "outreach.example [all]" });
  });

  it("writes the black list entry before the move", async () => {
    const h = await protectedHarness();
    h.state.accessPoints = [accessPoint()];
    h.ai.replies["*"] = 0.99;
    h.mail.put(INBOX1, { author: "mike@outreach.example", date: arrived(h) });
    let storedAtMove: Entry[] = [];
    const move = h.mail.move.bind(h.mail);
    h.mail.move = async (ids, target) => {
      storedAtMove = structuredClone((h.store.data[KEY_ENTRIES] ?? []) as Entry[]);
      await move(ids, target);
    };
    await h.engine.tick();
    expect(storedAtMove.some((entry) => entry.value === "outreach.example" && entry.list === "black")).toBe(true);
  });

  it("leaves a message at or below the cutoff and remembers nothing about the sender", async () => {
    const h = await protectedHarness();
    h.state.accessPoints = [accessPoint()];
    h.ai.replies["*"] = 0.85;
    const first = h.mail.put(INBOX1, { author: "new@prospect.example", date: arrived(h) });
    await h.engine.tick();
    expect(h.mail.ids(INBOX1)).toEqual([first.id]);
    expect(h.state.entries.has(entryKey("domain", "prospect.example", "all"))).toBe(false);
    expect(h.log()).toMatchObject([{ outcome: "passed", action: "none", score: 0.85, reason: "ai-below" }]);

    h.mail.put(INBOX1, { author: "new@prospect.example", date: arrived(h) });
    await h.engine.tick();
    expect(h.ai.calls).toHaveLength(2);
  });

  it("uses the edited cutoff", async () => {
    const h = await protectedHarness();
    h.state.accessPoints = [accessPoint()];
    h.state.settings.cutoff = 0.5;
    h.ai.replies["*"] = 0.51;
    h.mail.put(INBOX1, { author: "x@y.example", date: arrived(h) });
    await h.engine.tick();
    expect(h.log()[0]?.outcome).toBe("spam");
  });

  it("scopes AI entries to the account when new entries are per account", async () => {
    const h = await protectedHarness();
    h.state.accessPoints = [accessPoint()];
    h.state.settings.newEntryScope = "account";
    h.ai.replies["*"] = 1;
    h.mail.put(INBOX2, { author: "x@outreach.example", date: arrived(h) });
    await h.engine.tick();
    expect(h.state.entries.get(entryKey("domain", "outreach.example", "account2"))?.list).toBe("black");
    expect(h.state.entries.has(entryKey("domain", "outreach.example", "all"))).toBe(false);
  });

  it("sends the AI only the documented payload", async () => {
    const h = await protectedHarness();
    h.state.accessPoints = [accessPoint()];
    h.mail.put(INBOX1, {
      author: "Mike Growth <Mike@Outreach.example>",
      recipients: ["Me <me@mycompany.example>"],
      ccList: ["hidden@mycompany.example"],
      subject: "Quick question",
      date: arrived(h),
      headers: { "reply-to": ["sales@outreach.example"], "x-secret": ["never sent"] },
      body: "We sell SEO.",
    });
    await h.engine.tick();
    expect(h.ai.calls).toHaveLength(1);
    expect(h.ai.calls[0]?.prompt).toBe(h.state.settings.prompt);
    expect(h.ai.calls[0]?.payload).toBe(
      [
        "From: mike@outreach.example",
        "Reply-To: sales@outreach.example",
        "To: Me <me@mycompany.example>",
        "Subject: Quick question",
        `Date: ${new Date(arrived(h)).toISOString()}`,
        "",
        "We sell SEO.",
      ].join("\n"),
    );
  });

  it("scores from headers with an empty body when the body is unavailable or the message is over 5 MB", async () => {
    const h = await protectedHarness();
    h.state.accessPoints = [accessPoint()];
    h.mail.put(INBOX1, { author: "a@big.example", date: arrived(h), size: MAX_BODY_MESSAGE_SIZE + 1, body: "huge" });
    await h.engine.tick();
    expect(h.mail.bodyReads).toBe(0);
    expect(h.ai.calls[0]?.payload.endsWith("\n\n")).toBe(true);

    h.mail.failBody = true;
    h.mail.put(INBOX1, { author: "b@broken.example", date: arrived(h) });
    await h.engine.tick();
    expect(h.ai.calls).toHaveLength(2);
    expect(h.ai.calls[1]?.payload.endsWith("\n\n")).toBe(true);
  });

  it("truncates the body to 20,000 characters", async () => {
    const h = await protectedHarness();
    h.state.accessPoints = [accessPoint()];
    h.mail.put(INBOX1, { author: "a@long.example", date: arrived(h), body: "x".repeat(BODY_LIMIT * 2) });
    await h.engine.tick();
    const body = h.ai.calls[0]?.payload.split("\n\n")[1] ?? "";
    expect(body).toHaveLength(BODY_LIMIT);
  });

  describe("no AI verdict", () => {
    it("leaves the message in place by default when no access point is enabled", async () => {
      const h = await protectedHarness();
      h.state.accessPoints = [accessPoint({ enabled: false })];
      const msg = h.mail.put(INBOX1, { author: "x@unknown.example", date: arrived(h) });
      await h.engine.tick();
      expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
      expect(h.ai.calls).toHaveLength(0);
      expect(h.log()).toMatchObject([{ outcome: "no-verdict", action: "none", reason: "no-ai" }]);
    });

    it("applies the setting when all access points fail", async () => {
      const h = await protectedHarness();
      h.state.accessPoints = [accessPoint({ id: "a", name: "A" }), accessPoint({ id: "b", name: "B" })];
      h.ai.replies = { a: transient(), b: quota() };
      h.state.settings.noVerdictAction = "junk";
      const msg = h.mail.put(INBOX1, { author: "x@unknown.example", date: arrived(h) });
      await h.engine.tick();
      expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
      expect([...h.state.entries.values()].filter((entry) => entry.list === "black")).toEqual([]);
      expect(h.log()).toMatchObject([
        { outcome: "no-verdict", action: "junk", reason: "ai-failed", detail: "A: HTTP 500; B: HTTP 429", score: null },
      ]);
    });

    it("reads nothing when every enabled access point cools down or needs attention", async () => {
      const h = await protectedHarness();
      h.state.accessPoints = [
        accessPoint({ id: "a", cooldownUntil: h.clock.now + HOUR }),
        accessPoint({ id: "b", needsAttention: true }),
        accessPoint({ id: "c", enabled: false }),
      ];
      h.state.settings.noVerdictAction = "junk";
      const msg = h.mail.put(INBOX1, { author: "x@unknown.example", date: arrived(h) });
      await h.engine.tick();
      expect(h.mail.bodyReads + h.mail.headerReads).toBe(0);
      expect(h.ai.calls).toHaveLength(0);
      expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
      expect(h.log()).toMatchObject([{ outcome: "no-verdict", action: "junk", reason: "ai-failed", detail: "" }]);
    });

    it("moves to the screening folder of the account", async () => {
      const h = await protectedHarness();
      h.mail.addFolder(SCREEN1);
      h.state.settings.screeningFolders = [SCREEN1];
      h.state.settings.noVerdictAction = "screening";
      const work = h.mail.put(INBOX1, { author: "x@unknown.example", date: arrived(h) });
      const priv = h.mail.put(INBOX2, { author: "y@unknown.example", date: arrived(h) });
      await h.engine.tick();
      expect(h.mail.ids(SCREEN1)).toEqual([work.id]);
      expect(h.mail.ids(INBOX2)).toEqual([priv.id]);
      expect(h.log()).toMatchObject([
        { outcome: "no-verdict", action: "screening", reason: "no-ai" },
        { outcome: "no-verdict", action: "none", reason: "no-screening-folder" },
      ]);
    });
  });

  describe("observation mode", () => {
    it("computes and logs but moves nothing and writes no AI entry", async () => {
      const h = await protectedHarness();
      h.state.settings.observation = true;
      h.state.accessPoints = [accessPoint()];
      h.ai.replies["*"] = 0.99;
      h.state.addEntry({ list: "black", kind: "domain", value: "blocked.example", scope: "all", source: "manual" }, 1);
      const blocked = h.mail.put(INBOX1, { author: "a@blocked.example", date: arrived(h) });
      const spam = h.mail.put(INBOX1, { author: "b@outreach.example", date: arrived(h) });
      await h.engine.tick();
      expect(h.mail.ids(INBOX1)).toEqual([blocked.id, spam.id]);
      expect(h.mail.moves).toHaveLength(0);
      expect(h.state.entries.has(entryKey("domain", "outreach.example", "all"))).toBe(false);
      expect(h.log()).toMatchObject([
        { outcome: "blocked", action: "junk", observed: true },
        { outcome: "spam", action: "junk", observed: true, score: 0.99, detail: "outreach.example [all]" },
      ]);
    });

    it("records observed messages as processed so they are not scored twice", async () => {
      const h = await protectedHarness();
      h.state.settings.observation = true;
      h.state.accessPoints = [accessPoint()];
      h.mail.put(INBOX1, { author: "b@outreach.example", date: arrived(h) });
      await h.engine.tick();
      await h.engine.tick();
      expect(h.ai.calls).toHaveLength(1);
      expect(h.log()).toHaveLength(1);
    });
  });

  describe("failures leave mail where it is", () => {
    it("logs a failed move and does not retry it", async () => {
      const h = await protectedHarness();
      h.state.addEntry({ list: "black", kind: "domain", value: "blocked.example", scope: "all", source: "manual" }, 1);
      const msg = h.mail.put(INBOX1, { author: "a@blocked.example", date: arrived(h) });
      h.mail.failMoves = true;
      await h.engine.tick();
      expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
      expect(h.log()).toMatchObject([
        { outcome: "blocked", action: "none", reason: "move-failed", detail: "blocked.example [all]; move refused" },
      ]);
      h.mail.failMoves = false;
      await h.engine.tick();
      expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
      expect(h.log()).toHaveLength(1);
    });

    it("keeps the AI entry when the move after it fails", async () => {
      const h = await protectedHarness();
      h.state.accessPoints = [accessPoint()];
      h.ai.replies["*"] = 0.95;
      h.mail.failMoves = true;
      h.mail.put(INBOX1, { author: "a@outreach.example", date: arrived(h) });
      await h.engine.tick();
      expect(h.state.entries.get(entryKey("domain", "outreach.example", "all"))?.list).toBe("black");
      expect(h.log()[0]).toMatchObject({ outcome: "spam", action: "none", reason: "move-failed" });
    });

    it("logs an account without a Junk folder", async () => {
      const h = await protectedHarness();
      h.mail.removeFolder(JUNK1);
      h.state.addEntry({ list: "black", kind: "domain", value: "blocked.example", scope: "all", source: "manual" }, 1);
      const msg = h.mail.put(INBOX1, { author: "a@blocked.example", date: arrived(h) });
      await h.engine.tick();
      expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
      expect(h.log()).toMatchObject([{ outcome: "blocked", action: "none", reason: "no-junk-folder" }]);
    });

    it("scores a message whose sender cannot be parsed, like mail from any unknown sender", async () => {
      const h = await protectedHarness();
      h.state.accessPoints = [accessPoint()];
      h.ai.replies["*"] = 0.93;
      const msg = h.mail.put(INBOX1, { author: "undisclosed sender", date: arrived(h) });
      await h.engine.tick();
      expect(h.ai.calls).toHaveLength(1);
      expect(h.mail.ids(INBOX1)).toEqual([]);
      expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
      // There is no address, so nothing goes on the black list.
      expect([...h.state.entries.values()].filter((entry) => entry.source === "ai")).toEqual([]);
      expect(h.log()).toMatchObject([{ outcome: "spam", action: "junk", reason: "ai-above", detail: "", sender: "", via: "", score: 0.93 }]);
    });

    it("lets a message whose sender cannot be parsed pass when its score is not above the cutoff", async () => {
      const h = await protectedHarness();
      h.state.accessPoints = [accessPoint()];
      h.ai.replies["*"] = 0.1;
      const msg = h.mail.put(INBOX1, { author: "undisclosed sender", date: arrived(h) });
      await h.engine.tick();
      expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
      expect(h.log()).toMatchObject([{ outcome: "passed", action: "none", reason: "ai-below", sender: "" }]);
    });

    it("handles a message whose sender cannot be parsed by the setting for mail without a verdict when no AI service is on", async () => {
      const h = await protectedHarness();
      const msg = h.mail.put(INBOX1, { author: "undisclosed sender", date: arrived(h) });
      await h.engine.tick();
      expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
      expect(h.log()).toMatchObject([{ outcome: "no-verdict", action: "none", reason: "no-ai", sender: "" }]);
    });
  });

  it("lets a list entry added during scoring outrank the AI verdict", async () => {
    const h = await protectedHarness();
    h.state.accessPoints = [accessPoint()];
    h.ai.replies["*"] = () => {
      h.state.addEntry({ list: "white", kind: "domain", value: "outreach.example", scope: "all", source: "manual" }, 5);
      return 0.99;
    };
    const msg = h.mail.put(INBOX1, { author: "a@outreach.example", date: arrived(h) });
    await h.engine.tick();
    expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
    expect(h.state.entries.get(entryKey("domain", "outreach.example", "all"))).toMatchObject({ list: "white", source: "manual" });
    expect(h.log()[0]).toMatchObject({ outcome: "trusted", action: "none", reason: "white-domain", score: 0.99 });
  });

  describe("lists and settings that change while the message is decided", () => {
    const trust = (h: Harness): void => {
      h.state.addEntry({ list: "white", kind: "domain", value: "outreach.example", scope: "all", source: "manual" }, 5);
    };

    it("sends nothing to the AI when the sender is trusted while the body is read", async () => {
      const h = await protectedHarness();
      h.state.accessPoints = [accessPoint()];
      const read = h.mail.bodyText.bind(h.mail);
      h.mail.bodyText = async (id) => {
        trust(h);
        return read(id);
      };
      const msg = h.mail.put(INBOX1, { author: "a@outreach.example", date: arrived(h) });
      await h.engine.tick();
      expect(h.ai.calls).toHaveLength(0);
      expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
      expect(h.log()[0]).toMatchObject({ outcome: "trusted", reason: "white-domain", score: null });
    });

    it("asks no further access point once the sender is trusted", async () => {
      const h = await protectedHarness();
      h.state.accessPoints = [accessPoint({ id: "a", name: "A" }), accessPoint({ id: "b", name: "B" })];
      h.ai.replies = {
        a: () => {
          trust(h);
          throw transient();
        },
        b: 0.99,
      };
      h.mail.put(INBOX1, { author: "a@outreach.example", date: arrived(h) });
      await h.engine.tick();
      expect(h.ai.calls.map((call) => call.point)).toEqual(["a"]);
      expect(h.log()[0]).toMatchObject({ outcome: "trusted", action: "none" });
    });

    it("lets a sender trusted while every access point failed outrank the no AI verdict setting", async () => {
      const h = await protectedHarness();
      h.state.settings.noVerdictAction = "junk";
      h.state.accessPoints = [accessPoint()];
      h.ai.replies["*"] = () => {
        trust(h);
        throw transient();
      };
      const msg = h.mail.put(INBOX1, { author: "a@outreach.example", date: arrived(h) });
      await h.engine.tick();
      expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
      expect(h.log()[0]).toMatchObject({ outcome: "trusted", action: "none" });
    });

    it("moves nothing and writes no AI entry when observation mode is switched on during scoring", async () => {
      const h = await protectedHarness();
      h.state.accessPoints = [accessPoint()];
      h.ai.replies["*"] = () => {
        // The settings page replaces the settings object, as updateSettings does.
        h.state.settings = { ...h.state.settings, observation: true };
        return 0.99;
      };
      const msg = h.mail.put(INBOX1, { author: "a@outreach.example", date: arrived(h) });
      await h.engine.tick();
      expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
      expect(h.state.entries.has(entryKey("domain", "outreach.example", "all"))).toBe(false);
      expect(h.log()[0]).toMatchObject({ outcome: "spam", action: "junk", observed: true });
    });

    it("moves nothing when protection is paused during scoring", async () => {
      const h = await protectedHarness();
      h.state.accessPoints = [accessPoint()];
      h.ai.replies["*"] = () => {
        h.state.settings.protection = false;
        return 0.99;
      };
      const msg = h.mail.put(INBOX1, { author: "a@outreach.example", date: arrived(h) });
      await h.engine.tick();
      expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
      expect(h.state.entries.has(entryKey("domain", "outreach.example", "all"))).toBe(false);
      expect(h.log()[0]).toMatchObject({ outcome: "spam", observed: true });
    });

    it("uses the cutoff that is set when the score arrives", async () => {
      const h = await protectedHarness();
      h.state.accessPoints = [accessPoint()];
      h.ai.replies["*"] = () => {
        h.state.settings = { ...h.state.settings, cutoff: 0.99 };
        return 0.95;
      };
      const msg = h.mail.put(INBOX1, { author: "a@outreach.example", date: arrived(h) });
      await h.engine.tick();
      expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
      expect(h.log()[0]).toMatchObject({ outcome: "passed", score: 0.95 });
    });
  });
});

describe("forwarded mail", () => {
  const FORWARDER = "office@partner.example";

  async function forwardHarness(): Promise<Harness> {
    const h = await protectedHarness();
    h.state.settings.forwardingMailboxes = [FORWARDER];
    h.state.refreshDerived();
    // The forwarding mailbox itself is trusted: the user writes to it.
    h.state.addEntry({ list: "white", kind: "domain", value: "partner.example", scope: "all", source: "sent" }, 1);
    h.state.accessPoints = [accessPoint()];
    return h;
  }

  it("treats transparent forwards like direct mail, without configuration", async () => {
    const h = await protectedHarness();
    h.state.accessPoints = [accessPoint()];
    h.ai.replies["*"] = 0.97;
    const msg = h.mail.put(INBOX1, { author: "cold@outreach.example", recipients: ["alias@partner.example"], date: arrived(h) });
    await h.engine.tick();
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
    expect(h.state.entries.get(entryKey("domain", "outreach.example", "all"))?.list).toBe("black");
  });

  it("judges a wrapped forward by its original sender, not by the trusted forwarder", async () => {
    const h = await forwardHarness();
    h.ai.replies["*"] = 0.96;
    const msg = h.mail.put(INBOX1, {
      author: `Office <${FORWARDER}>`,
      date: arrived(h),
      headers: { "x-original-from": ["Cold <cold@outreach.example>"] },
    });
    await h.engine.tick();
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
    expect(h.ai.calls[0]?.payload.startsWith("From: cold@outreach.example\n")).toBe(true);
    expect(h.state.entries.get(entryKey("domain", "outreach.example", "all"))).toMatchObject({ list: "black", source: "ai" });
    expect(h.state.entries.get(entryKey("domain", "partner.example", "all"))?.list).toBe("white");
    expect(h.log()[0]).toMatchObject({ outcome: "spam", sender: "cold@outreach.example", via: FORWARDER });
  });

  it("lets a wrapped forward from a whitelisted original sender pass without AI", async () => {
    const h = await forwardHarness();
    h.state.addEntry({ list: "white", kind: "domain", value: "customer.example", scope: "all", source: "sent" }, 1);
    const msg = h.mail.put(INBOX1, { author: FORWARDER, date: arrived(h), attachedFrom: "Anna <anna@customer.example>" });
    await h.engine.tick();
    expect(h.mail.ids(INBOX1)).toEqual([msg.id]);
    expect(h.ai.calls).toHaveLength(0);
    expect(h.log()[0]).toMatchObject({ outcome: "trusted", sender: "anna@customer.example", via: FORWARDER });
  });

  it("blocks a wrapped forward from a blacklisted original sender found in the body", async () => {
    const h = await forwardHarness();
    h.state.addEntry({ list: "black", kind: "domain", value: "outreach.example", scope: "all", source: "manual" }, 1);
    const msg = h.mail.put(INBOX1, { author: FORWARDER, date: arrived(h), body: "FYI\n\nOd: Cold <cold@outreach.example>\nTemat: Oferta" });
    await h.engine.tick();
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
    expect(h.ai.calls).toHaveLength(0);
  });

  it("scores a wrapped forward with an unknown original sender and never blacklists the forwarder", async () => {
    const h = await forwardHarness();
    h.ai.replies["*"] = 0.99;
    const msg = h.mail.put(INBOX1, { author: FORWARDER, date: arrived(h), body: "Buy our SEO services" });
    await h.engine.tick();
    expect(h.ai.calls[0]?.payload.startsWith(`From: ${FORWARDER}\n`)).toBe(true);
    expect(h.mail.ids(JUNK1)).toEqual([msg.id]);
    expect([...h.state.entries.values()].filter((entry) => entry.list === "black")).toEqual([]);
    expect(h.log()[0]).toMatchObject({ outcome: "spam", action: "junk", sender: "", via: FORWARDER, detail: "" });
  });

  it("does not pass on the forwarder's reputation when the original sender is unknown", async () => {
    const h = await forwardHarness();
    h.ai.replies["*"] = 0.1;
    h.mail.put(INBOX1, { author: FORWARDER, date: arrived(h), body: "Hello" });
    await h.engine.tick();
    expect(h.ai.calls).toHaveLength(1);
    expect(h.log()[0]).toMatchObject({ outcome: "passed", reason: "ai-below" });
  });

  it("reads headers and body once per message", async () => {
    const h = await forwardHarness();
    h.mail.put(INBOX1, { author: FORWARDER, date: arrived(h), body: "No forwarded header" });
    await h.engine.tick();
    expect(h.mail.headerReads).toBe(1);
    expect(h.mail.bodyReads).toBe(1);
  });
});
