import { afterEach, describe, expect, it, vi } from "vitest";

/** Loads the i18n helpers against a locale file with the given language and messages. */
async function withLocale(code: string, messages: Record<string, string> = {}) {
  vi.resetModules();
  vi.stubGlobal("browser", {
    i18n: {
      getMessage: (name: string, substitutions: string[] = []) =>
        (name === "localeCode" ? code : (messages[name] ?? "")).replace(/\$(\d)/g, (_match, index: string) => substitutions[Number(index) - 1] ?? ""),
    },
  });
  return import("../../src/tb/i18n");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("plural forms", () => {
  it("uses one and many in English", async () => {
    const { pluralForm } = await withLocale("en");
    expect([0, 1, 2, 5, 21].map(pluralForm)).toEqual(["many", "one", "many", "many", "many"]);
  });

  it("uses all three forms in Polish", async () => {
    const { pluralForm } = await withLocale("pl");
    expect([1, 2, 3, 4, 5, 11, 12, 14, 21, 22, 25, 102, 112].map(pluralForm)).toEqual([
      "one",
      "few",
      "few",
      "few",
      "many",
      "many",
      "many",
      "many",
      "many",
      "few",
      "many",
      "few",
      "many",
    ]);
  });

  it("follows the language of the strings, not the language of Thunderbird, and falls back to English", async () => {
    // A locale file without a usable language code: the English forms apply.
    const { pluralForm } = await withLocale("");
    expect([1, 2].map(pluralForm)).toEqual(["one", "many"]);
  });

  it("reads the message of the form, with the count as the first substitution", async () => {
    const { tn } = await withLocale("pl", {
      entries_one: "$1 wpis",
      entries_few: "$1 wpisy",
      entries_many: "$1 wpisów na liście $2",
    });
    expect(tn("entries", 1)).toBe("1 wpis");
    expect(tn("entries", 3)).toBe("3 wpisy");
    expect(tn("entries", 5, "białej")).toBe("5 wpisów na liście białej");
  });
});

describe("numbers in messages", () => {
  it("are written the way the language of the strings writes them", async () => {
    const english = await withLocale("en", { read: "Messages read: $1 of $2." });
    expect(english.t("read", 12000, "many")).toBe("Messages read: 12,000 of many.");
    const polish = await withLocale("pl", { read: "Przeczytane wiadomości: $1." });
    // Polish groups thousands with a no-break space, from five digits on.
    expect(polish.t("read", 12000).replace(/\s/g, " ")).toBe("Przeczytane wiadomości: 12 000.");
    expect(polish.t("read", 4000)).toBe("Przeczytane wiadomości: 4000.");
  });
});

describe("messages", () => {
  it("returns the key when a message is missing, and builds code keys without hyphens", async () => {
    const { t, tCode } = await withLocale("en", { outcome_no_verdict: "No verdict" });
    expect(t("missingKey")).toBe("missingKey");
    expect(tCode("outcome", "no-verdict")).toBe("No verdict");
  });
});
