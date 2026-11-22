import { describe, expect, it } from "vitest";
import { logEntryKey } from "../../src/core/keys";
import { breakableParts, formatLogTime, formatScore, formatShortcut, formatShortTime, logTimeParts, matchesSearch, parseEntryDetail } from "../../src/options/format";
import { folderDisplayName } from "../../src/options/model";

describe("times", () => {
  const now = new Date(2026, 10, 21, 22, 0).getTime();

  it("shows the time for today, the day and month for this year, the whole date for older moments", () => {
    expect(formatShortTime(new Date(2026, 10, 21, 20, 35).getTime(), now, "en-GB")).toBe("20:35");
    expect(formatShortTime(new Date(2026, 10, 20, 20, 35).getTime(), now, "en-GB")).toBe("20/11");
    expect(formatShortTime(new Date(2025, 11, 31, 20, 35).getTime(), now, "en-GB")).toBe("31/12/2025");
    expect(formatShortTime(new Date(2026, 10, 20, 20, 35).getTime(), now, "pl")).toBe("20.11");
  });

  it("adds the time of day to other days in the log", () => {
    expect(formatLogTime(new Date(2026, 10, 21, 8, 5).getTime(), now, "en-GB")).toBe("08:05");
    expect(formatLogTime(new Date(2026, 10, 20, 8, 5).getTime(), now, "en-GB")).toBe("20/11, 08:05");
  });

  it("gives the log the date and the time of day as two parts, so that the date can stand above the time", () => {
    expect(logTimeParts(new Date(2026, 10, 21, 8, 5).getTime(), now, "en-GB")).toEqual({ date: null, clock: "08:05" });
    expect(logTimeParts(new Date(2026, 10, 20, 8, 5).getTime(), now, "en-GB")).toEqual({ date: "20/11", clock: "08:05" });
    expect(logTimeParts(new Date(2025, 11, 31, 20, 35).getTime(), now, "pl")).toEqual({ date: "31.12.2025", clock: "20:35" });
    // A 12-hour clock has an AM or PM that makes the time longer. It still is one part.
    expect(logTimeParts(new Date(2025, 11, 31, 20, 35).getTime(), now, "en-US").date).toBe("12/31/2025");
    expect(logTimeParts(new Date(2025, 11, 31, 20, 35).getTime(), now, "en-US").clock).toMatch(/^08:35\sPM$/);
  });

  it("writes scores with two decimals, the way the language of the strings writes numbers", () => {
    expect(formatScore(0.9)).toBe("0.90");
    expect(formatScore(0.97, "pl")).toBe("0,97");
    expect(formatScore(1, "pl")).toBe("1,00");
    expect(formatScore(null)).toBe("");
  });
});

describe("addresses in tables", () => {
  it("may break after the @ and before a dot, and nowhere else", () => {
    expect(breakableParts("rozliczenia@hosting-dostawca.test")).toEqual(["rozliczenia@", "hosting-dostawca", ".test"]);
    expect(breakableParts("mail.example.co.uk")).toEqual(["mail", ".example", ".co", ".uk"]);
    expect(breakableParts("m.wisniewska@nowyklient.test").join("")).toBe("m.wisniewska@nowyklient.test");
    expect(breakableParts("")).toEqual([]);
  });
});

describe("shortcuts", () => {
  it("are written with the modifier glyphs on macOS, in the order Apple uses", () => {
    expect(formatShortcut("Alt+B", true)).toBe("⌥B");
    expect(formatShortcut("Alt+Shift+B", true)).toBe("⌥⇧B");
    expect(formatShortcut("Shift+Alt+W", true)).toBe("⌥⇧W");
    expect(formatShortcut("MacCtrl+Shift+Comma", true)).toBe("⌃⇧,");
    // In a shortcut of an add-on, Ctrl means Command on macOS.
    expect(formatShortcut("Ctrl+Alt+Up", true)).toBe("⌥⌘↑");
    expect(formatShortcut("B", true)).toBe("B");
  });

  it("stay as Thunderbird reports them on other systems", () => {
    expect(formatShortcut("Alt+Shift+B", false)).toBe("Alt+Shift+B");
    expect(formatShortcut("Shift+B", false)).toBe("Shift+B");
  });
});

describe("log details", () => {
  it("takes the entry and its scope out of the detail of a list decision", () => {
    expect(parseEntryDetail("bulkmail.test [all]")).toEqual({ value: "bulkmail.test", scope: "all" });
    expect(parseEntryDetail("anna@customer.test [account1]")).toEqual({ value: "anna@customer.test", scope: "account1" });
  });

  it("leaves every other detail alone", () => {
    expect(parseEntryDetail("")).toBeNull();
    expect(parseEntryDetail("Jev: HTTP 500: Mock HTTP 500; OpenAI: HTTP 500")).toBeNull();
    expect(parseEntryDetail("bulkmail.test [all]; move refused")).toBeNull();
  });

  it("finds every word of a search in the sender or the subject, in any case", () => {
    expect(matchesSearch("faktura", "rozliczenia@hosting-dostawca.test", "", "Faktura FV/11/2026")).toBe(true);
    expect(matchesSearch("hosting FV", "rozliczenia@hosting-dostawca.test", "", "Faktura FV/11/2026")).toBe(true);
    expect(matchesSearch("hosting umowa", "rozliczenia@hosting-dostawca.test", "", "Faktura FV/11/2026")).toBe(false);
    expect(matchesSearch("  ", "anything")).toBe(true);
  });

  it("names a log entry by its moment, its message and its kind", () => {
    const entry = { time: 5, accountId: "account1", messageId: "m@test", sender: "a@b.example", outcome: "passed", test: false };
    expect(logEntryKey(entry)).toBe("5|account1|m@test|a@b.example|passed|");
    // The test score of the same message is another entry.
    expect(logEntryKey({ ...entry, test: true })).not.toBe(logEntryKey(entry));
    // An entry stored before the Message-ID was recorded has none.
    expect(logEntryKey({ time: 5, accountId: "account1", sender: "a@b.example", outcome: "passed", test: false })).toBe("5|account1||a@b.example|passed|");
  });
});

describe("folder names", () => {
  const names = new Map([
    ["/INBOX", "Odebrane"],
    ["/INBOX/Klienci", "Klienci"],
    ["/INBOX/Klienci/2026", "2026"],
  ]);

  it("shows the name Thunderbird gives a folder, with the names of the folders it is in", () => {
    expect(folderDisplayName({ path: "/INBOX", name: "Odebrane" }, names)).toBe("Odebrane");
    expect(folderDisplayName({ path: "/INBOX/Klienci/2026", name: "2026" }, names)).toBe("Odebrane / Klienci / 2026");
  });

  it("falls back to the path where a name is missing", () => {
    expect(folderDisplayName({ path: "/Archive/Old", name: "" }, names)).toBe("Archive / Old");
  });
});
