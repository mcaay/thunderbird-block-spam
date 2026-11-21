import { describe, expect, it } from "vitest";
import { applySettingsPatch, manualEntry } from "../../src/core/edit";
import { accountReference, applyImport, buildExport, EXPORT_FORMAT } from "../../src/core/exportImport";
import type { ExportFile, ImportContext } from "../../src/core/exportImport";
import { entriesFromArray, entryKey } from "../../src/core/lists";
import { folderKey } from "../../src/core/ports";
import { defaultSettings, validateSettings, ValidationError } from "../../src/core/settings";
import type { AccessPoint, AccountInfo, Entry, Settings } from "../../src/core/types";
import { accessPoint } from "../helpers/harness";

const NOW = Date.UTC(2026, 10, 21, 12);

const ACCOUNTS: AccountInfo[] = [
  { id: "account1", name: "Work", email: "me@mycompany.example" },
  { id: "account2", name: "Private", email: "me@gmail.com" },
  { id: "account3", name: "Local Folders", email: null },
];

function entry(partial: Partial<Entry>): Entry {
  return { list: "white", kind: "domain", value: "customer.example", scope: "all", source: "sent", addedAt: 100, ...partial };
}

function source(): { settings: Settings; entries: ReturnType<typeof entriesFromArray>; accessPoints: AccessPoint[] } {
  const settings = defaultSettings(NOW);
  settings.protection = true;
  settings.protectionOnAt = NOW;
  settings.cutoff = 0.7;
  settings.prompt = "Custom prompt";
  settings.smart = false;
  settings.observation = true;
  settings.newEntryScope = "account";
  settings.noVerdictAction = "screening";
  settings.publicDomainsAdded = ["myisp.example"];
  settings.publicDomainsRemoved = ["gmail.com"];
  settings.forwardingMailboxes = ["office@partner.example"];
  settings.forwardLabels = ["From:", "Von:"];
  settings.sentFoldersAdded = [{ accountId: "account1", path: "/Sent/Clients" }];
  settings.sentFoldersRemoved = [{ accountId: "account2", path: "/Sent" }];
  settings.monitoredFoldersAdded = [{ accountId: "account1", path: "/Projects" }];
  settings.screeningFolders = [{ accountId: "account1", path: "/Screening" }];
  return {
    settings,
    entries: entriesFromArray([
      entry({}),
      entry({ list: "black", kind: "address", value: "cold@outreach.example", scope: "account1", source: "manual" }),
      entry({ kind: "address", value: "friend@gmail.com", scope: "account3" }),
      entry({ value: "gone.example", scope: "account9" }),
    ]),
    accessPoints: [
      accessPoint({ id: "ap1", name: "OpenAI", apiKey: "sk-secret", cooldownUntil: 99, needsAttention: true, lastError: "HTTP 401" }),
      accessPoint({
        id: "ap2",
        type: "chatgpt",
        name: "ChatGPT plan",
        apiKey: "",
        auth: { clientId: "oaiapp_x", subject: "s", email: "e@x", idToken: "idtoken", accessToken: "accesstoken", refreshToken: "refreshtoken", expiresAt: 1, earliestRefreshAt: 0, scopes: [] },
      }),
    ],
  };
}

function context(partial: Partial<ImportContext> = {}): ImportContext {
  let counter = 0;
  return {
    accounts: ACCOUNTS,
    folders: new Set(
      [
        { accountId: "account1", path: "/Sent/Clients" },
        { accountId: "account2", path: "/Sent" },
        { accountId: "account1", path: "/Projects" },
        { accountId: "account1", path: "/Screening" },
      ].map(folderKey),
    ),
    newId: () => `new-${++counter}`,
    needsSecret: (definition) => definition.type !== "systemone",
    ...partial,
  };
}

function target(entries: Entry[] = []): { settings: Settings; entries: ReturnType<typeof entriesFromArray>; accessPoints: AccessPoint[] } {
  return { settings: defaultSettings(NOW - 1000), entries: entriesFromArray(entries), accessPoints: [accessPoint({ id: "local", name: "Local" })] };
}

describe("export", () => {
  it("writes lists, settings and access point definitions", () => {
    const { file, skipped } = buildExport(source(), ACCOUNTS, NOW);
    expect(file.format).toBe(EXPORT_FORMAT);
    expect(file.version).toBe(1);
    expect(file.exportedAt).toBe("2026-11-21T12:00:00.000Z");
    expect(file.entries).toEqual([
      entry({ scope: "all" }),
      { ...entry({ list: "black", kind: "address", value: "cold@outreach.example", source: "manual" }), scope: { account: "me@mycompany.example" } },
      { ...entry({ kind: "address", value: "friend@gmail.com" }), scope: { account: "name:Local Folders" } },
    ]);
    expect(file.settings).toEqual({
      observation: true,
      newEntryScope: "account",
      noVerdictAction: "screening",
      smart: false,
      cutoff: 0.7,
      prompt: "Custom prompt",
      publicDomainsAdded: ["myisp.example"],
      publicDomainsRemoved: ["gmail.com"],
      forwardingMailboxes: ["office@partner.example"],
      forwardLabels: ["From:", "Von:"],
      sentFoldersAdded: [{ account: "me@mycompany.example", path: "/Sent/Clients" }],
      sentFoldersRemoved: [{ account: "me@gmail.com", path: "/Sent" }],
      monitoredFoldersAdded: [{ account: "me@mycompany.example", path: "/Projects" }],
      screeningFolders: [{ account: "me@mycompany.example", path: "/Screening" }],
    });
    expect(skipped).toBe(1);
  });

  it("never contains secrets, temporary state or local switches", () => {
    const { file } = buildExport(source(), ACCOUNTS, NOW);
    expect(file.accessPoints).toEqual([
      { type: "openai-chat", name: "OpenAI", enabled: true, endpoint: "https://api.example.com/v1", model: "model-1" },
      { type: "chatgpt", name: "ChatGPT plan", enabled: true, endpoint: "https://api.example.com/v1", model: "model-1" },
    ]);
    const text = JSON.stringify(file);
    for (const secret of ["sk-secret", "refreshtoken", "accesstoken", "idtoken", "oaiapp_x", "cooldownUntil", "needsAttention", "lastError", "protection", "installedAt", "account1"]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("names an account by its email address, or by its name when it has none", () => {
    expect(accountReference(ACCOUNTS[0] as AccountInfo)).toBe("me@mycompany.example");
    expect(accountReference(ACCOUNTS[2] as AccountInfo)).toBe("name:Local Folders");
  });
});

describe("import: merge", () => {
  it("unites the lists and leaves settings and access points untouched", () => {
    const { file } = buildExport(source(), ACCOUNTS, NOW);
    const local = target([
      entry({ value: "local.example", source: "manual" }),
      entry({ value: "customer.example", source: "manual", addedAt: 5 }),
      entry({ list: "white", kind: "address", value: "cold@outreach.example", scope: "account1", source: "sent" }),
    ]);
    const before = { settings: structuredClone(local.settings), accessPoints: structuredClone(local.accessPoints) };
    const report = applyImport(local, file, "merge", context());
    expect(report).toMatchObject({ mode: "merge", entriesAdded: 1, entriesReplaced: 1, entriesUnchanged: 1, skipped: [], accessPoints: 0 });
    expect(local.settings).toEqual(before.settings);
    expect(local.accessPoints).toEqual(before.accessPoints);
    expect(local.entries.size).toBe(4);
    // The same key in the same list keeps the local entry.
    expect(local.entries.get(entryKey("domain", "customer.example", "all"))).toMatchObject({ source: "manual", addedAt: 5 });
    // An imported entry replaces an existing entry with the same key in the other list.
    expect(local.entries.get(entryKey("address", "cold@outreach.example", "account1"))).toMatchObject({ list: "black", source: "manual" });
    expect(local.entries.get(entryKey("address", "friend@gmail.com", "account3"))?.list).toBe("white");
    expect(local.entries.has(entryKey("domain", "local.example", "all"))).toBe(true);
  });

  it("attaches account-scoped entries to the local account with the same email address", () => {
    const { file } = buildExport(source(), ACCOUNTS, NOW);
    const elsewhere: AccountInfo[] = [
      { id: "accountA", name: "Job", email: "me@mycompany.example" },
      { id: "accountB", name: "Other", email: "someone@else.example" },
    ];
    const local = target();
    const report = applyImport(local, file, "merge", context({ accounts: elsewhere }));
    expect(local.entries.has(entryKey("address", "cold@outreach.example", "accountA"))).toBe(true);
    expect(report.skipped).toEqual([{ kind: "entry", item: "friend@gmail.com", account: "name:Local Folders" }]);
    expect(report.entriesAdded).toBe(2);
  });
});

describe("import: replace", () => {
  it("overwrites lists, settings and access point definitions", () => {
    const { file } = buildExport(source(), ACCOUNTS, NOW);
    const local = target([entry({ value: "local.example", source: "manual" })]);
    local.settings.protection = false;
    const report = applyImport(local, file, "replace", context());
    expect(report).toMatchObject({ mode: "replace", entriesAdded: 3, skipped: [], accessPoints: 2 });
    expect([...local.entries.keys()].sort()).toEqual(
      [entryKey("domain", "customer.example", "all"), entryKey("address", "cold@outreach.example", "account1"), entryKey("address", "friend@gmail.com", "account3")].sort(),
    );
    expect(local.entries.get(entryKey("domain", "customer.example", "all"))).toEqual(entry({}));
    expect(local.settings).toMatchObject({
      cutoff: 0.7,
      prompt: "Custom prompt",
      smart: false,
      observation: true,
      newEntryScope: "account",
      noVerdictAction: "screening",
      publicDomainsAdded: ["myisp.example"],
      publicDomainsRemoved: ["gmail.com"],
      forwardingMailboxes: ["office@partner.example"],
      forwardLabels: ["From:", "Von:"],
      sentFoldersAdded: [{ accountId: "account1", path: "/Sent/Clients" }],
      sentFoldersRemoved: [{ accountId: "account2", path: "/Sent" }],
      monitoredFoldersAdded: [{ accountId: "account1", path: "/Projects" }],
      screeningFolders: [{ accountId: "account1", path: "/Screening" }],
    });
    expect(validateSettings(structuredClone(local.settings))).toEqual(local.settings);
  });

  it("keeps protection and the installation time: importing never switches protection on", () => {
    const { file } = buildExport(source(), ACCOUNTS, NOW);
    const local = target();
    applyImport(local, file, "replace", context());
    expect(local.settings.protection).toBe(false);
    expect(local.settings.protectionOnAt).toBeNull();
    expect(local.settings.installedAt).toBe(NOW - 1000);
  });

  it("imports access points without secrets and marks those that need one", () => {
    const { file } = buildExport(source(), ACCOUNTS, NOW);
    const local = target();
    applyImport(local, file, "replace", context());
    expect(local.accessPoints).toEqual([
      { id: "new-1", type: "openai-chat", name: "OpenAI", enabled: true, endpoint: "https://api.example.com/v1", model: "model-1", apiKey: "", auth: null, cooldownUntil: 0, needsAttention: true, lastError: "" },
      { id: "new-2", type: "chatgpt", name: "ChatGPT plan", enabled: true, endpoint: "https://api.example.com/v1", model: "model-1", apiKey: "", auth: null, cooldownUntil: 0, needsAttention: true, lastError: "" },
    ]);
  });

  it("skips and reports items whose account or folder is not found", () => {
    const { file } = buildExport(source(), ACCOUNTS, NOW);
    const local = target();
    const report = applyImport(
      local,
      file,
      "replace",
      context({
        accounts: [{ id: "accountA", name: "Job", email: "me@mycompany.example" }],
        folders: new Set([folderKey({ accountId: "accountA", path: "/Projects" })]),
      }),
    );
    expect(report.skipped).toEqual([
      { kind: "entry", item: "friend@gmail.com", account: "name:Local Folders" },
      { kind: "screeningFolder", item: "/Screening", account: "" },
      { kind: "sentFolder", item: "/Sent/Clients", account: "" },
      { kind: "sentFolder", item: "/Sent", account: "me@gmail.com" },
    ]);
    expect(local.settings.monitoredFoldersAdded).toEqual([{ accountId: "accountA", path: "/Projects" }]);
    expect(local.settings.sentFoldersAdded).toEqual([]);
    expect(local.settings.screeningFolders).toEqual([]);
  });
});

describe("import: validation", () => {
  it("rejects files that are not valid exports and changes nothing", () => {
    const { file } = buildExport(source(), ACCOUNTS, NOW);
    const broken: unknown[] = [
      null,
      "text",
      { ...file, format: "something-else" },
      { ...file, version: 2 },
      { ...file, entries: [{ list: "white" }] },
      { ...file, entries: [{ ...file.entries[0], value: "NOT NORMALIZED.example" }] },
      { ...file, entries: [{ ...file.entries[0], scope: { account: 5 } }] },
      { ...file, settings: { ...file.settings, cutoff: 3 } },
      { ...file, settings: { ...file.settings, prompt: "" } },
      { ...file, settings: { ...file.settings, noVerdictAction: "delete" } },
      { ...file, accessPoints: [{ type: "telepathy", name: "x", enabled: true, endpoint: "", model: "" }] },
      { ...file, accessPoints: undefined },
    ];
    for (const mode of ["merge", "replace"] as const) {
      for (const value of broken) {
        const local = target([entry({ value: "local.example" })]);
        const before = structuredClone({ settings: local.settings, entries: [...local.entries.values()], accessPoints: local.accessPoints });
        // Merge reads only the entries, so a file with broken settings is still rejected as a whole.
        expect(() => applyImport(local, value, mode, context()), JSON.stringify(value)?.slice(0, 80)).toThrowError(ValidationError);
        expect({ settings: local.settings, entries: [...local.entries.values()], accessPoints: local.accessPoints }).toEqual(before);
      }
    }
  });

  it("round-trips an export through JSON", () => {
    const { file } = buildExport(source(), ACCOUNTS, NOW);
    const parsed = JSON.parse(JSON.stringify(file)) as ExportFile;
    const local = target();
    const report = applyImport(local, parsed, "replace", context());
    expect(report.skipped).toEqual([]);
    const again = buildExport(local, ACCOUNTS, NOW);
    expect(again.file.entries).toEqual(file.entries);
    expect(again.file.settings).toEqual(file.settings);
    expect(again.file.accessPoints).toEqual(file.accessPoints);
  });
});

describe("edits from the settings page", () => {
  const base = defaultSettings(NOW);

  it("applies valid changes to a copy", () => {
    const { settings, invalid } = applySettingsPatch(base, { cutoff: 0.555, smart: false, observation: true, noVerdictAction: "junk", newEntryScope: "account", prompt: "New prompt" });
    expect(invalid).toEqual([]);
    expect(settings).toMatchObject({ cutoff: 0.56, smart: false, observation: true, noVerdictAction: "junk", newEntryScope: "account", prompt: "New prompt" });
    expect(base.cutoff).toBe(0.85);
  });

  it("refuses an empty prompt, a cutoff outside 0 to 1, wrong types and unknown settings", () => {
    for (const patch of [{ prompt: "  " }, { cutoff: 1.01 }, { cutoff: -0.1 }, { cutoff: "0.5" }, { smart: "yes" }, { noVerdictAction: "delete" }, { protection: true }, { installedAt: 0 }, { schemaVersion: 9 }, "text", null]) {
      expect(() => applySettingsPatch(base, patch), JSON.stringify(patch)).toThrowError(ValidationError);
    }
  });

  it("normalizes lists and reports invalid items", () => {
    const { settings, invalid } = applySettingsPatch(base, {
      publicDomainsAdded: ["MyISP.example", "not a domain", "myisp.example", ""],
      forwardingMailboxes: ["Office@Partner.example", "nonsense"],
      forwardLabels: [" Von: ", "", "De:", "x".repeat(60)],
    });
    expect(settings.publicDomainsAdded).toEqual(["myisp.example"]);
    expect(settings.forwardingMailboxes).toEqual(["office@partner.example"]);
    expect(settings.forwardLabels).toEqual(["Von:", "De:"]);
    expect(invalid).toEqual(["not a domain", "nonsense", "x".repeat(60)]);
  });

  it("keeps a domain either added or removed, never both", () => {
    const removed = applySettingsPatch({ ...base, publicDomainsAdded: ["a.example"] }, { publicDomainsRemoved: ["a.example", "gmail.com"] }).settings;
    expect(removed.publicDomainsAdded).toEqual([]);
    expect(removed.publicDomainsRemoved).toEqual(["a.example", "gmail.com"]);
    const added = applySettingsPatch({ ...base, publicDomainsRemoved: ["gmail.com"] }, { publicDomainsAdded: ["gmail.com"] }).settings;
    expect(added.publicDomainsRemoved).toEqual([]);
    expect(added.publicDomainsAdded).toEqual(["gmail.com"]);
  });

  it("allows one screening folder per account and removes duplicate folders", () => {
    const folder = { accountId: "account1", path: "/Screening" };
    expect(applySettingsPatch(base, { screeningFolders: [folder] }).settings.screeningFolders).toEqual([folder]);
    expect(() => applySettingsPatch(base, { screeningFolders: [folder, { accountId: "account1", path: "/Other" }] })).toThrowError(/one folder per account/);
    expect(applySettingsPatch(base, { monitoredFoldersAdded: [folder, folder] }).settings.monitoredFoldersAdded).toEqual([folder]);
    expect(() => applySettingsPatch(base, { sentFoldersAdded: [{ accountId: "", path: "/x" }] })).toThrowError(ValidationError);
  });

  it("builds a manual entry with an explicit scope", () => {
    const accounts = ["account1", "account2"];
    expect(manualEntry({ list: "black", kind: "address", value: " Cold@Outreach.example ", scope: "all" }, accounts)).toEqual({
      list: "black",
      kind: "address",
      value: "cold@outreach.example",
      scope: "all",
      source: "manual",
    });
    expect(manualEntry({ list: "white", kind: "domain", value: "Mail.Sales.Example.co.uk", scope: "account2" }, accounts)).toEqual({
      list: "white",
      kind: "domain",
      value: "example.co.uk",
      scope: "account2",
      source: "manual",
    });
  });

  it("refuses invalid manual entries", () => {
    const accounts = ["account1"];
    for (const input of [
      { list: "grey", kind: "address", value: "a@b.example", scope: "all" },
      { list: "white", kind: "regex", value: "a@b.example", scope: "all" },
      { list: "white", kind: "address", value: "not an address", scope: "all" },
      { list: "white", kind: "domain", value: "a@b.example", scope: "all" },
      { list: "white", kind: "domain", value: "", scope: "all" },
      { list: "white", kind: "address", value: "a@b.example", scope: "account7" },
      { list: "white", kind: "address", value: 5, scope: "all" },
    ]) {
      expect(() => manualEntry(input, accounts), JSON.stringify(input)).toThrowError(ValidationError);
    }
  });
});
