import { describe, expect, it } from "vitest";
import { isNoWish, NO_WISH, outcomeOfScan, outcomeWithoutService, readWish, withoutService } from "../../src/core/protectionWish";

describe("protection that waits for the scan, as stored", () => {
  it("reads a wish that waits, with the dates of its scan", () => {
    expect(readWish({ waiting: { since: 5, from: null, to: 9 }, outcome: null })).toEqual({ ...NO_WISH, waiting: { since: 5, from: null, to: 9 } });
  });

  it("reads what the last wish came to", () => {
    const outcome = { kind: "errors", at: 7, scanned: 120 };
    expect(readWish({ waiting: null, outcome })).toEqual({ ...NO_WISH, outcome });
  });

  it("takes anything that is not a wish for none, so nothing is switched on because of data that cannot be read", () => {
    for (const raw of [undefined, null, "on", 1, [], {}, { waiting: true }, { waiting: { since: "now", from: null, to: null } }, { waiting: { since: 1, from: "x", to: null } }]) {
      expect(readWish(raw), JSON.stringify(raw)).toEqual(NO_WISH);
    }
    expect(readWish({ waiting: null, outcome: { kind: "maybe", at: 1, scanned: 1 } })).toEqual(NO_WISH);
  });
});

describe("AI services that wait for the scan, as stored", () => {
  it("reads the services that wait and what became of the last ones", () => {
    const services = { since: 5, from: null, to: 9, ids: ["a", "b"] };
    const servicesOutcome = { kind: "cancelled", at: 7, scanned: 3, ids: ["a"] };
    expect(readWish({ services, servicesOutcome })).toEqual({ ...NO_WISH, services, servicesOutcome });
    // A wish written before services could wait reads as it did.
    expect(readWish({ waiting: { since: 1, from: null, to: null }, outcome: null })).toMatchObject({ services: null, servicesOutcome: null });
  });

  it("takes services without an id, without dates or without a known outcome for none", () => {
    for (const raw of [{ services: { since: 5, from: null, to: null, ids: [] } }, { services: { since: 5, from: null, to: null } }, { services: { ids: ["a"] } }, { services: { since: 5, from: null, to: null, ids: [7, ""] } }, { servicesOutcome: { kind: "on", at: 1, scanned: 1 } }, { servicesOutcome: { kind: "later", at: 1, scanned: 1, ids: ["a"] } }]) {
      expect(readWish(raw), JSON.stringify(raw)).toEqual(NO_WISH);
    }
    expect(readWish({ services: { since: 5, from: null, to: null, ids: ["a", "a", 3] } }).services?.ids).toEqual(["a"]);
  });

  it("takes one service off the wish and off its outcome, and knows when nothing is left to store", () => {
    const services = { since: 5, from: null, to: null, ids: ["a", "b"] };
    expect(withoutService(services, "a")).toEqual({ ...services, ids: ["b"] });
    expect(withoutService(withoutService(services, "a"), "b")).toBeNull();
    expect(withoutService(null, "a")).toBeNull();
    const outcome = { kind: "on" as const, at: 1, scanned: 2, ids: ["a"] };
    expect(outcomeWithoutService(outcome, "b")).toEqual(outcome);
    expect(outcomeWithoutService(outcome, "a")).toBeNull();
    expect(isNoWish(NO_WISH)).toBe(true);
    expect(isNoWish({ ...NO_WISH, services })).toBe(false);
    expect(isNoWish({ ...NO_WISH, servicesOutcome: outcome })).toBe(false);
  });
});

describe("the choice to move mail without a verdict that waits for the scan, as stored", () => {
  it("reads the choice that waits and what became of the last one", () => {
    const noVerdict = { since: 5, from: null, to: 9, action: "junk" };
    const noVerdictOutcome = { kind: "errors", at: 7, scanned: 3, action: "screening" };
    expect(readWish({ noVerdict, noVerdictOutcome })).toEqual({ ...NO_WISH, noVerdict, noVerdictOutcome });
    // A wish written before the choice could wait reads as it did.
    expect(readWish({ waiting: { since: 1, from: null, to: null }, outcome: null })).toMatchObject({ noVerdict: null, noVerdictOutcome: null });
  });

  it("takes a choice that moves nothing, has no dates or no known outcome for none, so nothing changes because of data that cannot be read", () => {
    for (const raw of [
      { noVerdict: { since: 5, from: null, to: null, action: "leave" } },
      { noVerdict: { since: 5, from: null, to: null } },
      { noVerdict: { action: "junk" } },
      { noVerdict: "junk" },
      { noVerdictOutcome: { kind: "on", at: 1, scanned: 1 } },
      { noVerdictOutcome: { kind: "later", at: 1, scanned: 1, action: "junk" } },
    ]) {
      expect(readWish(raw), JSON.stringify(raw)).toEqual(NO_WISH);
    }
  });

  it("has to be stored while it waits and until what became of it was seen", () => {
    expect(isNoWish({ ...NO_WISH, noVerdict: { since: 5, from: null, to: null, action: "junk" } })).toBe(false);
    expect(isNoWish({ ...NO_WISH, noVerdictOutcome: { kind: "on", at: 1, scanned: 2, action: "junk" } })).toBe(false);
  });
});

describe("what a scan that has ended makes of the wish", () => {
  it("switches protection on after a scan that ran to its end, also when it read no message", () => {
    expect(outcomeOfScan({ cancelled: false, errors: [], scanned: 40 }, 9)).toEqual({ kind: "on", at: 9, scanned: 40 });
    expect(outcomeOfScan({ cancelled: false, errors: [], scanned: 0 }, 9)).toEqual({ kind: "on", at: 9, scanned: 0 });
  });

  it("drops the wish after Cancel and after a folder that could not be read, and says which", () => {
    expect(outcomeOfScan({ cancelled: true, errors: [], scanned: 3 }, 9).kind).toBe("cancelled");
    expect(outcomeOfScan({ cancelled: false, errors: ["/Sent: could not be read"], scanned: 3 }, 9).kind).toBe("errors");
    // A scan that was cancelled after a folder failed was cancelled: that is what the user did.
    expect(outcomeOfScan({ cancelled: true, errors: ["/Sent: could not be read"], scanned: 3 }, 9).kind).toBe("cancelled");
  });
});
