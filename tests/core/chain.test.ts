import { describe, expect, it } from "vitest";
import { AccessPointError, DEFAULT_COOLDOWN_MS, isAvailable, REQUEST_TIMEOUT_MS, runChain } from "../../src/core/chain";
import type { AccessPoint } from "../../src/core/types";
import { accessPoint, harness, HOUR, INBOX1, quota, transient, unauthorized } from "../helpers/harness";

const NOW = 1_000_000;

function scorer(replies: Record<string, number | Error>): { calls: string[]; score: (point: AccessPoint) => Promise<number> } {
  const calls: string[] = [];
  return {
    calls,
    score: async (point) => {
      calls.push(point.id);
      const reply = replies[point.id];
      if (reply instanceof Error) {
        throw reply;
      }
      return reply ?? 0.5;
    },
  };
}

function points(): AccessPoint[] {
  return [accessPoint({ id: "a", name: "A" }), accessPoint({ id: "b", name: "B" }), accessPoint({ id: "c", name: "C" })];
}

describe("chain", () => {
  it("uses a 30 second timeout and a 10 minute default cool-down", () => {
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_COOLDOWN_MS).toBe(600_000);
  });

  it("returns the first valid score and stops", async () => {
    const list = points();
    const { calls, score } = scorer({ a: 0.91, b: 0.1 });
    const result = await runChain(list, score, () => NOW);
    expect(result).toEqual({ verdict: { score: 0.91, accessPoint: "A" }, available: true, attempts: [], stateChanged: false });
    expect(calls).toEqual(["a"]);
  });

  it("tries access points in the order the user arranged", async () => {
    const list = points().reverse();
    const { calls, score } = scorer({ c: transient(), b: transient(), a: 0.3 });
    const result = await runChain(list, score, () => NOW);
    expect(calls).toEqual(["c", "b", "a"]);
    expect(result.verdict).toEqual({ score: 0.3, accessPoint: "A" });
    expect(result.attempts).toEqual([
      { accessPoint: "C", error: "HTTP 500" },
      { accessPoint: "B", error: "HTTP 500" },
    ]);
  });

  it("fails over on network errors, timeouts, 5xx, refusals and invalid output", async () => {
    const list = points();
    const { score } = scorer({ a: new Error("socket hang up"), b: new AccessPointError("transient", "the model refused to answer"), c: 0.4 });
    const result = await runChain(list, score, () => NOW);
    expect(result.verdict?.accessPoint).toBe("C");
    expect(list[0]).toMatchObject({ needsAttention: false, cooldownUntil: 0, lastError: "socket hang up" });
    expect(list[1]).toMatchObject({ needsAttention: false, cooldownUntil: 0, lastError: "the model refused to answer" });
    expect(result.stateChanged).toBe(true);
  });

  it("rejects scores outside 0 to 1 and tries the next access point", async () => {
    const list = points();
    const { score } = scorer({ a: 1.7, b: Number.NaN, c: 0.2 });
    const result = await runChain(list, score, () => NOW);
    expect(result.verdict).toEqual({ score: 0.2, accessPoint: "C" });
    expect(result.attempts.map((attempt) => attempt.error)).toEqual(["invalid score", "invalid score"]);
  });

  it("skips an access point after 429 until Retry-After has passed", async () => {
    const list = points();
    let now = NOW;
    const first = scorer({ a: quota(90_000), b: 0.6 });
    await runChain(list, first.score, () => now);
    expect(list[0]?.cooldownUntil).toBe(NOW + 90_000);

    now = NOW + 60_000;
    const second = scorer({ a: 0.9, b: 0.6 });
    expect((await runChain(list, second.score, () => now)).verdict?.accessPoint).toBe("B");
    expect(second.calls).toEqual(["b"]);

    now = NOW + 90_001;
    const third = scorer({ a: 0.9, b: 0.6 });
    const result = await runChain(list, third.score, () => now);
    expect(result.verdict?.accessPoint).toBe("A");
    expect(list[0]).toMatchObject({ cooldownUntil: 0, lastError: "" });
    expect(result.stateChanged).toBe(true);
  });

  it("cools down for 10 minutes when no Retry-After is given", async () => {
    const list = points();
    await runChain(list, scorer({ a: quota(), b: 0.6 }).score, () => NOW);
    expect(list[0]?.cooldownUntil).toBe(NOW + DEFAULT_COOLDOWN_MS);
    expect(isAvailable(list[0] as AccessPoint, NOW + DEFAULT_COOLDOWN_MS - 1)).toBe(false);
    expect(isAvailable(list[0] as AccessPoint, NOW + DEFAULT_COOLDOWN_MS)).toBe(true);
  });

  it("marks an access point as needing attention after 401 or 403 and skips it until edited", async () => {
    const list = points();
    await runChain(list, scorer({ a: unauthorized(), b: 0.6 }).score, () => NOW);
    expect(list[0]).toMatchObject({ needsAttention: true, lastError: "HTTP 401" });

    const later = scorer({ a: 0.9, b: 0.6 });
    await runChain(list, later.score, () => NOW + 365 * 24 * HOUR);
    expect(later.calls).toEqual(["b"]);

    // Editing clears the flag.
    (list[0] as AccessPoint).needsAttention = false;
    const edited = scorer({ a: 0.9 });
    expect((await runChain(list, edited.score, () => NOW)).verdict?.accessPoint).toBe("A");
  });

  it("skips disabled access points", async () => {
    const list = [accessPoint({ id: "a", name: "A", enabled: false }), accessPoint({ id: "b", name: "B" })];
    const { calls, score } = scorer({ b: 0.6 });
    expect((await runChain(list, score, () => NOW)).verdict?.accessPoint).toBe("B");
    expect(calls).toEqual(["b"]);
  });

  it("has no verdict when all access points fail", async () => {
    const list = points();
    const result = await runChain(list, scorer({ a: transient(), b: quota(), c: unauthorized() }).score, () => NOW);
    expect(result.verdict).toBeNull();
    expect(result.available).toBe(true);
    expect(result.attempts).toHaveLength(3);
  });

  it("has no verdict and is not available when none is enabled", async () => {
    const none = await runChain([], scorer({}).score, () => NOW);
    expect(none).toEqual({ verdict: null, available: false, attempts: [], stateChanged: false });
    const disabled = await runChain([accessPoint({ enabled: false })], scorer({}).score, () => NOW);
    expect(disabled.available).toBe(false);
  });
});

describe("chain in the pipeline", () => {
  it("lets a second subscription take over when the first runs out, and stores the cool-down", async () => {
    const h = await harness();
    h.protect();
    h.state.accessPoints = [accessPoint({ id: "main", name: "Main plan" }), accessPoint({ id: "backup", name: "Backup key" })];
    h.ai.replies = { main: quota(), backup: 0.95 };
    h.clock.now += HOUR;
    h.mail.put(INBOX1, { author: "a@outreach.example", date: h.clock.now - 60_000 });
    h.mail.put(INBOX1, { author: "b@other.example", date: h.clock.now - 60_000 });
    await h.engine.tick();
    expect(h.ai.calls.map((call) => call.point)).toEqual(["main", "backup", "backup"]);
    expect(h.log().map((entry) => entry.accessPoint)).toEqual(["Backup key", "Backup key"]);
    const stored = h.store.data.accessPoints as AccessPoint[];
    expect(stored[0]?.cooldownUntil).toBe(h.clock.now + DEFAULT_COOLDOWN_MS);
    expect(stored[0]?.lastError).toBe("HTTP 429");
  });
});
