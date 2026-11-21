import { describe, expect, it } from "vitest";
import { appendLog, EMPTY_LOG_META, LOG_CHUNK_SIZE, LOG_MAX_CHUNKS, LOG_MAX_ENTRIES, logChunkKey } from "../../src/core/log";
import type { LogMeta } from "../../src/core/log";
import { buildPayload, BODY_LIMIT, truncateBody } from "../../src/core/payload";
import { dayKey, processedId, ProcessedSet } from "../../src/core/processed";
import { DEFAULT_CUTOFF, isSpam, llmInstructions, OUTPUT_LINE, parseLlmScore, parseProbability } from "../../src/core/score";
import { DEFAULT_PROMPT, defaultSettings, validateAccessPoints, validateEntries, validateSettings, ValidationError } from "../../src/core/settings";
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
  it("identifies a message by account and Message-ID", async () => {
    expect(await processedId(message({ accountId: "account1", headerMessageId: "abc@host" }))).toBe("account1 abc@host");
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
    expect(bucket).toEqual({ day: "2026-11-21", ids: ["a"] });
    expect(set.add("b", NOW + DAY, NOW).day).toBe("2026-11-22");
    expect(set.has("a")).toBe(true);
    expect(set.has("c")).toBe(false);
    expect(set.days()).toEqual(["2026-11-21", "2026-11-22"]);
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
    expect(set.add("future", NOW, future).day).toBe(dayKey(future));
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
