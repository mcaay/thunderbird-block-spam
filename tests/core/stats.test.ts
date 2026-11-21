import { describe, expect, it } from "vitest";
import { aiHealth, summarizeDay } from "../../src/core/stats";
import type { LogEntry } from "../../src/core/types";
import { accessPoint } from "../helpers/harness";

function logged(time: number, partial: Partial<LogEntry> = {}): LogEntry {
  return {
    time,
    accountId: "account1",
    account: "Work",
    sender: "a@b.example",
    via: "",
    subject: "S",
    outcome: "trusted",
    action: "none",
    score: null,
    accessPoint: "",
    reason: "white-domain",
    detail: "",
    observed: false,
    test: false,
    messageId: "m@test",
    ...partial,
  };
}

describe("today's figures from the log", () => {
  const dayStart = 1000;

  it("counts the decisions of the day, the moves to Junk and the AI scores", () => {
    const summary = summarizeDay(
      [
        logged(999, { outcome: "spam", action: "junk", score: 0.99 }), // yesterday
        logged(1000),
        logged(1500, { outcome: "blocked", action: "junk" }),
        logged(1600, { outcome: "spam", action: "junk", score: 0.97 }),
        logged(1700, { outcome: "passed", score: 0.08 }),
        logged(1800, { outcome: "no-verdict", action: "screening" }),
      ],
      dayStart,
    );
    expect(summary).toEqual({ checked: 5, junk: 2, scored: 2 });
  });

  it("counts an observed decision as checked, but not as moved", () => {
    expect(summarizeDay([logged(2000, { outcome: "spam", action: "junk", score: 0.93, observed: true })], dayStart)).toEqual({
      checked: 1,
      junk: 0,
      scored: 1,
    });
  });

  it("leaves out test scores and releases from a screening folder", () => {
    const summary = summarizeDay(
      [logged(2000, { outcome: "spam", score: 0.95, test: true }), logged(2100, { outcome: "released", action: "inbox" })],
      dayStart,
    );
    expect(summary).toEqual({ checked: 0, junk: 0, scored: 0 });
  });
});

describe("AI health", () => {
  it("counts the services that are switched on and those that would be asked now", () => {
    const now = 50_000;
    const points = [
      accessPoint({ id: "ok" }),
      accessPoint({ id: "paused", cooldownUntil: now + 1 }),
      accessPoint({ id: "recovered", cooldownUntil: now }),
      accessPoint({ id: "attention", needsAttention: true }),
      accessPoint({ id: "off", enabled: false }),
    ];
    expect(aiHealth(points, now)).toEqual({ enabled: 4, working: 2 });
    expect(aiHealth([], now)).toEqual({ enabled: 0, working: 0 });
  });
});
