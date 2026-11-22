import { describe, expect, it } from "vitest";
import { NO_WISH, outcomeOfScan, readWish } from "../../src/core/protectionWish";

describe("protection that waits for the scan, as stored", () => {
  it("reads a wish that waits, with the dates of its scan", () => {
    expect(readWish({ waiting: { since: 5, from: null, to: 9 }, outcome: null })).toEqual({ waiting: { since: 5, from: null, to: 9 }, outcome: null });
  });

  it("reads what the last wish came to", () => {
    const outcome = { kind: "errors", at: 7, scanned: 120 };
    expect(readWish({ waiting: null, outcome })).toEqual({ waiting: null, outcome });
  });

  it("takes anything that is not a wish for none, so nothing is switched on because of data that cannot be read", () => {
    for (const raw of [undefined, null, "on", 1, [], {}, { waiting: true }, { waiting: { since: "now", from: null, to: null } }, { waiting: { since: 1, from: "x", to: null } }]) {
      expect(readWish(raw), JSON.stringify(raw)).toEqual(NO_WISH);
    }
    expect(readWish({ waiting: null, outcome: { kind: "maybe", at: 1, scanned: 1 } })).toEqual(NO_WISH);
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
