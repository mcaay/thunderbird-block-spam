import { describe, expect, it } from "vitest";
import { appendLog, EMPTY_LOG_META, LOG_CHUNK_SIZE, LOG_MAX_CHUNKS, LOG_MAX_ENTRIES, logChunkKey, validateLogEntry } from "../../src/core/log";
import type { LogMeta } from "../../src/core/log";
import { buildPayload, BODY_LIMIT, truncateBody } from "../../src/core/payload";
import { dayKey, PROCESSED_PART_SIZE, processedId, ProcessedSet } from "../../src/core/processed";
import { DEFAULT_CUTOFF, isSpam, llmInstructions, OUTPUT_LINE, parseLlmScore, parseProbability } from "../../src/core/score";
import {
  DEFAULT_PROMPT,
  defaultSettings,
  invalidSettings,
  isSettingName,
  validateAccessPoints,
  validateEntries,
  validateSettings,
  ValidationError,
  withDefaults,
} from "../../src/core/settings";
import { AppState, KEY_ENTRIES, KEY_SETTINGS } from "../../src/core/state";
import type { LogEntry } from "../../src/core/types";
import { BUNDLED_PUBLIC_DOMAINS } from "../../src/data/publicDomains";
import { makeState, MemoryStore, message, NOW, reload } from "../helpers/fakes";

const DAY = 24 * 60 * 60 * 1000;

function logEntry(index: number): LogEntry {
  return {
    time: index,
    accountId: "account1",
    account: "Work",
    sender: `s${index}@example.com`,
    via: "",
    subject: `Subject ${index}`,
    outcome: "trusted",
    action: "none",
    score: null,
    accessPoint: "",
    reason: "white-domain",
    detail: "",
    observed: false,
    test: false,
    messageId: `msg-${index}@test`,
  };
}

describe("score parsing", () => {
  it("accepts 0, 1 and numbers between them with one or two decimals", () => {
    expect(parseLlmScore("0")).toBe(0);
    expect(parseLlmScore("1")).toBe(1);
    expect(parseLlmScore("0.5")).toBe(0.5);
    expect(parseLlmScore("0.85")).toBe(0.85);
    expect(parseLlmScore(" 0.07\n")).toBe(0.07);
    expect(parseLlmScore("1.0")).toBe(1);
    expect(parseLlmScore("1.00")).toBe(1);
    expect(parseLlmScore("0.00")).toBe(0);
  });

  it("rejects everything else", () => {
    for (const reply of ["", "0.853", "1.5", "1.01", "2", "-0.1", ".5", "0,85", "85%", "0.85.", "Score: 0.85", "0.85 because it is spam", "yes", "1e-1", "0x1", "NaN"]) {
      expect(parseLlmScore(reply), reply).toBeNull();
    }
  });

  it("rounds decision model probabilities to two decimals", () => {
    expect(parseProbability(0.8731)).toBe(0.87);
    expect(parseProbability(0.0412)).toBe(0.04);
    expect(parseProbability(0.999)).toBe(1);
    expect(parseProbability(0)).toBe(0);
    expect(parseProbability(1)).toBe(1);
  });

  it("rejects values that are not probabilities", () => {
    for (const value of [1.2, -0.1, Number.NaN, Number.POSITIVE_INFINITY, "0.5", null, undefined, {}]) {
      expect(parseProbability(value)).toBeNull();
    }
  });

  it("is spam only above the cutoff", () => {
    expect(DEFAULT_CUTOFF).toBe(0.85);
    expect(isSpam(0.86, 0.85)).toBe(true);
    expect(isSpam(0.85, 0.85)).toBe(false);
    expect(isSpam(0.1, 0)).toBe(true);
    expect(isSpam(1, 1)).toBe(false);
  });

  it("appends the fixed output line to the prompt for LLMs", () => {
    expect(OUTPUT_LINE).toBe("Reply with only a number between 0.00 and 1.00: the probability that the answer is yes.");
    expect(llmInstructions("Is this spam?\n")).toBe(`Is this spam?\n\n${OUTPUT_LINE}`);
  });
});

describe("payload", () => {
  it("has exactly the documented shape", () => {
    expect(
      buildPayload({
        from: "cold@outreach.example",
        replyTo: "Sales <sales@outreach.example>",
        to: ["Me <me@mycompany.example>", "other@mycompany.example"],
        subject: "Quick question",
        date: Date.UTC(2026, 10, 21, 9, 30),
        body: "Hello\nthere",
      }),
    ).toBe(
      [
        "From: cold@outreach.example",
        "Reply-To: Sales <sales@outreach.example>",
        "To: Me <me@mycompany.example>, other@mycompany.example",
        "Subject: Quick question",
        "Date: 2026-11-21T09:30:00.000Z",
        "",
        "Hello\nthere",
      ].join("\n"),
    );
  });

  it("leaves out Reply-To when there is none", () => {
    const payload = buildPayload({ from: "a@b.example", replyTo: null, to: [], subject: "S", date: 0, body: "" });
    expect(payload).toBe("From: a@b.example\nTo: \nSubject: S\nDate: \n\n");
  });

  it("keeps header values on one line", () => {
    const payload = buildPayload({ from: "a@b.example", replyTo: null, to: ["x@y.example"], subject: "Line one\r\nBcc: injected", date: 0, body: "" });
    expect(payload.split("\n")[2]).toBe("Subject: Line one Bcc: injected");
  });

  it("sends the first 20,000 characters of the body", () => {
    const body = "a".repeat(BODY_LIMIT + 500);
    expect(truncateBody(body)).toHaveLength(BODY_LIMIT);
    expect(truncateBody("short")).toBe("short");
  });

  it("never ends in half of a surrogate pair", () => {
    const body = `${"a".repeat(BODY_LIMIT - 1)}😀tail`;
    const cut = truncateBody(body);
    expect(cut).toHaveLength(BODY_LIMIT - 1);
    expect(cut.endsWith("a")).toBe(true);
  });
});

describe("processed set", () => {
  it("identifies a message by account, Message-ID, author and date", async () => {
    const base = { accountId: "account1", headerMessageId: "abc@host", author: "A <a@one.example>", date: 1000 };
    const first = await processedId(message(base));
    expect(first).toMatch(/^account1 #[0-9a-f]{24}$/);
    // A copy of the same message has the same identity.
    expect(await processedId(message(base))).toBe(first);
    // Another message that reuses the Message-ID does not.
    expect(await processedId(message({ ...base, author: "spam@two.example" }))).not.toBe(first);
    expect(await processedId(message({ ...base, date: 2000 }))).not.toBe(first);
    expect(await processedId(message({ ...base, headerMessageId: "other@host" }))).not.toBe(first);
    expect(await processedId(message({ ...base, accountId: "account2" }))).not.toBe(first);
  });

  it("falls back to a hash of date, author and subject", async () => {
    const base = { accountId: "account1", headerMessageId: "", date: 1000, author: "a@b.example", subject: "Hi" };
    const first = await processedId(message(base));
    expect(first).toMatch(/^account1 #[0-9a-f]{24}$/);
    expect(await processedId(message(base))).toBe(first);
    expect(await processedId(message({ ...base, subject: "Other" }))).not.toBe(first);
    expect(await processedId(message({ ...base, accountId: "account2" }))).not.toBe(first);
  });

  it("stores ids in per-day buckets", () => {
    const set = new ProcessedSet();
    const bucket = set.add("a", NOW, NOW);
    expect(bucket).toEqual({ key: "2026-11-21", ids: ["a"] });
    expect(set.add("b", NOW + DAY, NOW)?.key).toBe("2026-11-22");
    expect(set.add("a", NOW, NOW)).toBeNull();
    expect(set.has("a")).toBe(true);
    expect(set.has("c")).toBe(false);
    expect(set.days()).toEqual(["2026-11-21", "2026-11-22"]);
  });

  it("splits a busy day into parts, so that one message writes at most one small part", () => {
    const set = new ProcessedSet();
    const written = Array.from({ length: 250 }, (_, index) => set.add(`id${index}`, NOW, NOW));
    expect(written.every((part) => part !== null && part.ids.length <= PROCESSED_PART_SIZE)).toBe(true);
    expect([...new Set(written.map((part) => part?.key))]).toEqual(["2026-11-21", "2026-11-21:1", "2026-11-21:2"]);
    const stored = Object.fromEntries(written.map((part) => [part?.key ?? "", [...(part?.ids ?? [])]]));
    const again = new ProcessedSet(stored);
    expect(Array.from({ length: 250 }, (_, index) => again.has(`id${index}`)).every(Boolean)).toBe(true);
    // The next id goes into the part that has room, never into a full one.
    expect(again.add("new", NOW, NOW)).toMatchObject({ key: "2026-11-21:2" });
    expect(again.prune(NOW + 40 * DAY).sort()).toEqual(["2026-11-21", "2026-11-21:1", "2026-11-21:2"]);
  });

  it("continues a day stored as one large bucket in a new part", () => {
    const old = Array.from({ length: 150 }, (_, index) => `old${index}`);
    const set = new ProcessedSet({ "2026-11-21": old });
    expect(set.has("old149")).toBe(true);
    expect(set.add("new", NOW, NOW)).toEqual({ key: "2026-11-21:1", ids: ["new"] });
  });

  it("prunes buckets after 30 days", () => {
    const set = new ProcessedSet({ "2026-10-21": ["old"], "2026-10-22": ["edge"], "2026-11-21": ["new"] });
    expect(set.prune(NOW)).toEqual(["2026-10-21"]);
    expect(set.has("old")).toBe(false);
    expect(set.has("edge")).toBe(true);
    expect(set.has("new")).toBe(true);
  });

  it("files a message dated in the future under its own date", () => {
    const set = new ProcessedSet();
    const future = NOW + 400 * DAY;
    expect(set.add("future", NOW, future)?.key).toBe(dayKey(future));
    set.prune(NOW + 100 * DAY);
    expect(set.has("future")).toBe(true);
  });
});

describe("log", () => {
  it("appends to the newest chunk", () => {
    const write = appendLog(EMPTY_LOG_META, [logEntry(1)], logEntry(2));
    expect(write.meta).toEqual({ first: 0, last: 0 });
    expect(write.chunkIndex).toBe(0);
    expect(write.chunk.map((entry) => entry.time)).toEqual([1, 2]);
    expect(write.removeChunks).toEqual([]);
  });

  it("starts a new chunk when the newest one is full", () => {
    const full = Array.from({ length: LOG_CHUNK_SIZE }, (_, index) => logEntry(index));
    const write = appendLog({ first: 0, last: 3 }, full, logEntry(999));
    expect(write.meta).toEqual({ first: 0, last: 4 });
    expect(write.chunkIndex).toBe(4);
    expect(write.chunk).toHaveLength(1);
  });

  it("is capped at 5000 entries", () => {
    expect(LOG_CHUNK_SIZE * LOG_MAX_CHUNKS).toBe(LOG_MAX_ENTRIES);
    let meta: LogMeta = EMPTY_LOG_META;
    const chunks = new Map<number, LogEntry[]>();
    for (let index = 0; index < LOG_MAX_ENTRIES + 3 * LOG_CHUNK_SIZE + 10; index += 1) {
      const write = appendLog(meta, chunks.get(meta.last) ?? [], logEntry(index));
      meta = write.meta;
      chunks.set(write.chunkIndex, write.chunk);
      for (const removed of write.removeChunks) {
        chunks.delete(removed);
      }
    }
    const stored = [...chunks.values()].reduce((sum, chunk) => sum + chunk.length, 0);
    expect(chunks.size).toBe(LOG_MAX_CHUNKS);
    expect(stored).toBeLessThanOrEqual(LOG_MAX_ENTRIES);
    expect(stored).toBeGreaterThan(LOG_MAX_ENTRIES - LOG_CHUNK_SIZE);
    expect(meta.last - meta.first + 1).toBe(LOG_MAX_CHUNKS);
  });

  it("shortens long subjects and details", () => {
    const write = appendLog(EMPTY_LOG_META, [], { ...logEntry(1), subject: "s".repeat(1000), detail: "d".repeat(1000) });
    expect(write.chunk[0]?.subject).toHaveLength(200);
    expect(write.chunk[0]?.detail).toHaveLength(300);
  });

  it("keeps the Message-ID whole, or not at all: a cut one could not be looked up", () => {
    const kept = appendLog(EMPTY_LOG_META, [], { ...logEntry(1), messageId: "m".repeat(300) });
    expect(kept.chunk[0]?.messageId).toHaveLength(300);
    const dropped = appendLog(EMPTY_LOG_META, [], { ...logEntry(1), messageId: "m".repeat(301) });
    expect(dropped.chunk[0]?.messageId).toBe("");
  });

  it("loads entries logged before the Message-ID was recorded with an empty one", () => {
    const { messageId: _unused, ...older } = logEntry(1);
    expect(validateLogEntry(older, "log:0[0]")).toEqual({ ...logEntry(1), messageId: "" });
    expect(validateLogEntry(logEntry(2), "log:0[1]").messageId).toBe("msg-2@test");
    expect(() => validateLogEntry({ ...logEntry(3), messageId: 7 }, "log:0[2]")).toThrowError(ValidationError);
  });
});

describe("settings and state", () => {
  it("starts with protection off and the documented defaults", () => {
    const settings = defaultSettings(NOW);
    expect(settings).toMatchObject({
      schemaVersion: 1,
      installedAt: NOW,
      protection: false,
      protectionOnAt: null,
      observation: false,
      newEntryScope: "shared",
      noVerdictAction: "leave",
      smart: true,
      cutoff: 0.85,
      prompt: DEFAULT_PROMPT,
      forwardLabels: ["From:", "Od:", "Nadawca:"],
    });
    expect(validateSettings(structuredClone(settings))).toEqual(settings);
  });

  it("rejects invalid settings", () => {
    const base = defaultSettings(NOW);
    const broken: unknown[] = [
      null,
      [],
      { ...base, schemaVersion: 2 },
      { ...base, cutoff: 1.5 },
      { ...base, cutoff: "0.85" },
      { ...base, prompt: "   " },
      { ...base, noVerdictAction: "delete" },
      { ...base, newEntryScope: "both" },
      { ...base, protection: "yes" },
      { ...base, sentFoldersAdded: [{ accountId: "a" }] },
      { ...base, screeningFolders: [{ accountId: "a", path: "/X" }, { accountId: "a", path: "/Y" }] },
      { ...base, forwardLabels: undefined },
    ];
    for (const value of broken) {
      expect(() => validateSettings(value)).toThrowError(ValidationError);
    }
  });

  it("names the settings whose stored value is not valid, each on its own", () => {
    const base = defaultSettings(NOW);
    expect(invalidSettings(base)).toEqual([]);
    expect(invalidSettings({ ...base, cutoff: 7 })).toEqual(["cutoff"]);
    expect(invalidSettings({ ...base, cutoff: 7, prompt: " ", smart: "yes" })).toEqual(["smart", "cutoff", "prompt"]);
    expect(invalidSettings({ ...base, forwardLabels: undefined })).toEqual(["forwardLabels"]);
  });

  it("names no single setting for settings of another version, or for something that is not a settings record", () => {
    const base = defaultSettings(NOW);
    expect(invalidSettings({ ...base, schemaVersion: 2, cutoff: 7 })).toBeNull();
    expect(invalidSettings(null)).toBeNull();
    expect(invalidSettings([])).toBeNull();
  });

  it("sets only the named settings back to their defaults", () => {
    const stored = { ...defaultSettings(NOW), cutoff: 7, protection: true, forwardingMailboxes: ["office@partner.example"] };
    const repaired = withDefaults(stored, ["cutoff"], NOW + 5);
    expect(repaired).toEqual({ ...stored, cutoff: 0.85 });
    expect(validateSettings(repaired)).toMatchObject({ cutoff: 0.85, protection: true, forwardingMailboxes: ["office@partner.example"] });
    expect(isSettingName("cutoff")).toBe(true);
    expect(isSettingName("entries")).toBe(false);
  });

  it("validates list entries", () => {
    const good = { list: "white", kind: "domain", value: "example.com", scope: "all", source: "sent", addedAt: 1 };
    expect(validateEntries([good])).toEqual([good]);
    for (const bad of [
      { ...good, list: "grey" },
      { ...good, kind: "regex" },
      { ...good, value: "Example.COM" },
      { ...good, kind: "address", value: "not-an-address" },
      { ...good, scope: "" },
      { ...good, source: "magic" },
      { ...good, addedAt: "yesterday" },
    ]) {
      expect(() => validateEntries([bad])).toThrowError(ValidationError);
    }
    expect(() => validateEntries({})).toThrowError(ValidationError);
  });

  it("validates access points", () => {
    const point = { id: "ap1", type: "openai-chat", name: "Local", enabled: true, endpoint: "http://localhost:11434/v1", model: "m", apiKey: "", auth: null, cooldownUntil: 0, needsAttention: false, lastError: "" };
    expect(validateAccessPoints([point])).toEqual([point]);
    expect(() => validateAccessPoints([point, point])).toThrowError(/unique ids/);
    expect(() => validateAccessPoints([{ ...point, type: "telepathy" }])).toThrowError(ValidationError);
    expect(() => validateAccessPoints([{ ...point, auth: { clientId: 1 } }])).toThrowError(ValidationError);
  });

  it("creates and stores defaults on first load", async () => {
    const { state, store } = await makeState();
    expect(state.settings.protection).toBe(false);
    expect(state.settings.installedAt).toBe(NOW);
    expect(state.entries.size).toBe(0);
    expect(state.lastTick).toBeNull();
    expect(state.hostId).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(store.data[KEY_SETTINGS]).toEqual(state.settings);
    expect((store.data.meta as { hostId: string }).hostId).toBe(state.hostId);
  });

  it("round-trips through storage", async () => {
    const { state, store } = await makeState();
    state.addEntry({ list: "white", kind: "domain", value: "example.com", scope: "all", source: "sent" }, 5);
    await state.saveEntries();
    state.settings.cutoff = 0.5;
    await state.saveSettings();
    await state.setLastTick(1234);
    await state.markProcessed("in", "account1 a@b", NOW, NOW);
    await state.markProcessed("sent", "account1 c@d", NOW, NOW);
    await state.log(logEntry(1));

    const again = await reload(store);
    expect([...again.entries.values()]).toEqual([...state.entries.values()]);
    expect(again.settings.cutoff).toBe(0.5);
    expect(again.lastTick).toBe(1234);
    expect(again.hostId).toBe(state.hostId);
    expect(again.isProcessed("in", "account1 a@b")).toBe(true);
    expect(again.isProcessed("in", "account1 c@d")).toBe(false);
    expect(again.isProcessed("sent", "account1 c@d")).toBe(true);
    expect(store.data[logChunkKey(0)]).toHaveLength(1);
  });

  it("logs a decision and records its message in one small write, however many messages a day brings", async () => {
    const { state, store } = await makeState();
    const sizes: number[] = [];
    const set = store.set.bind(store);
    store.set = async (items) => {
      sizes.push(JSON.stringify(items).length);
      await set(items);
    };
    for (let index = 0; index < 1000; index += 1) {
      await state.log(logEntry(index), { kind: "in", id: `account1 message-${index}@test`, now: NOW, messageDate: NOW });
    }
    expect(sizes).toHaveLength(1000);
    // One part of processed ids and one log chunk at most, not the whole day.
    expect(Math.max(...sizes)).toBeLessThan(LOG_CHUNK_SIZE * 400 + PROCESSED_PART_SIZE * 40);
    const again = await reload(store);
    expect(again.isProcessed("in", "account1 message-0@test")).toBe(true);
    expect(again.isProcessed("in", "account1 message-999@test")).toBe(true);
    expect(again.isProcessed("sent", "account1 message-999@test")).toBe(false);
  });

  it("writes entries once for changes made in the same turn", async () => {
    const { state, store } = await makeState();
    const before = store.writes;
    state.addEntry({ list: "white", kind: "domain", value: "a.example", scope: "all", source: "sent" }, 1);
    const first = state.saveEntries();
    state.addEntry({ list: "white", kind: "domain", value: "b.example", scope: "all", source: "sent" }, 1);
    const second = state.saveEntries();
    await Promise.all([first, second]);
    expect(store.writes - before).toBe(1);
    expect(store.data[KEY_ENTRIES]).toHaveLength(2);
  });

  it("puts an entry back exactly as it was, in place of whatever holds its key", async () => {
    const { state, store } = await makeState();
    const original = { list: "white", kind: "domain", value: "customer.example", scope: "all", source: "scan", addedAt: 123 } as const;
    state.addEntry({ list: "black", kind: "domain", value: "customer.example", scope: "all", source: "manual" }, NOW);
    state.whiteAdded = false;
    state.restoreEntry(original);
    await state.saveEntries();
    expect(store.data[KEY_ENTRIES]).toEqual([original]);
    // A restored white list entry releases mail from the screening folders like a new one.
    expect(state.whiteAdded).toBe(true);
  });

  it("flags white list additions for the screening sweep", async () => {
    const { state } = await makeState();
    state.addEntry({ list: "black", kind: "domain", value: "a.example", scope: "all", source: "manual" }, 1);
    expect(state.whiteAdded).toBe(false);
    state.addEntry({ list: "white", kind: "domain", value: "a.example", scope: "all", source: "manual" }, 2);
    expect(state.whiteAdded).toBe(true);
  });

  it("derives the public domains and the scope of new entries from settings", async () => {
    const { state } = await makeState();
    expect(state.publicDomains.has("gmail.com")).toBe(true);
    state.settings.publicDomainsRemoved = ["gmail.com"];
    state.settings.publicDomainsAdded = ["myisp.example"];
    state.settings.forwardingMailboxes = ["office@partner.example"];
    await state.saveSettings();
    expect(state.publicDomains.has("gmail.com")).toBe(false);
    expect(state.publicDomains.has("myisp.example")).toBe(true);
    expect(state.forwardingMailboxes.has("office@partner.example")).toBe(true);
    expect(state.newEntryScope("account1")).toBe("all");
    state.settings.newEntryScope = "account";
    expect(state.newEntryScope("account1")).toBe("account1");
  });

  it("refuses invalid stored data and repairs nothing", async () => {
    const good = defaultSettings(NOW);
    const cases: Record<string, unknown>[] = [
      { settings: { ...good, cutoff: 7 } },
      { settings: good, entries: [{ list: "white" }] },
      { settings: good, accessPoints: "none" },
      { settings: good, meta: { lastTick: "soon", hostId: "x" } },
      { settings: good, "processed:in:2026-11-21": [1, 2] },
      { settings: good, logMeta: { first: 3, last: 1 } },
      { settings: good, logMeta: { first: 0, last: 0 }, "log:0": "text" },
      // Every chunk the pages read is checked, and every field of its entries.
      { settings: good, logMeta: { first: 0, last: 1 }, "log:0": "broken older chunk", "log:1": [] },
      { settings: good, logMeta: { first: 0, last: 0 }, "log:0": [{}] },
      { settings: good, logMeta: { first: 0, last: 0 }, "log:0": [{ ...logEntry(1), score: "high" }] },
      { settings: good, logMeta: { first: 0, last: 0 }, "log:0": [{ ...logEntry(1), outcome: "deleted" }] },
      // A range that the pages would loop over without end.
      { settings: good, logMeta: { first: 0, last: 1e9 } },
      { settings: good, logMeta: { first: 0, last: 2 ** 60 } },
      { settings: good, logMeta: { first: 0.5, last: 1 } },
    ];
    for (const raw of cases) {
      const store = new MemoryStore();
      store.data = structuredClone(raw);
      await expect(AppState.load(structuredClone(raw), store, BUNDLED_PUBLIC_DOMAINS, NOW)).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(store.writes).toBe(0);
      expect(store.data).toEqual(raw);
    }
  });

  it("loads a full log and keeps appending to its newest chunk", async () => {
    const chunk = (from: number, count: number): LogEntry[] => Array.from({ length: count }, (_, index) => logEntry(from + index));
    const { state, store } = await makeState({
      settings: defaultSettings(NOW),
      logMeta: { first: 3, last: 3 + LOG_MAX_CHUNKS - 1 },
      [logChunkKey(3)]: chunk(0, LOG_CHUNK_SIZE),
      [logChunkKey(3 + LOG_MAX_CHUNKS - 1)]: [{ ...logEntry(9), score: 0.91, outcome: "spam", action: "junk", observed: true }],
    });
    await state.log(logEntry(10));
    expect(store.data[logChunkKey(3 + LOG_MAX_CHUNKS - 1)]).toHaveLength(2);
  });

  it("prunes processed buckets and clears the log", async () => {
    const { state, store } = await makeState({
      settings: defaultSettings(NOW),
      "processed:in:2026-09-01": ["old"],
      "processed:sent:2026-09-01": ["old"],
      "processed:in:2026-11-20": ["new"],
    });
    await state.pruneProcessed(NOW);
    expect(Object.keys(store.data).filter((key) => key.startsWith("processed:"))).toEqual(["processed:in:2026-11-20"]);

    await state.log(logEntry(1));
    await state.clearLog();
    expect(store.data[logChunkKey(0)]).toBeUndefined();
    expect(store.data.logMeta).toEqual({ first: 1, last: 1 });
    await state.log(logEntry(2));
    expect(store.data[logChunkKey(1)]).toHaveLength(1);
  });
});
