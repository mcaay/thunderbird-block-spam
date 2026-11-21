// The background page, loaded against a fake of the Thunderbird API and driven
// through the same requests the settings page and the popup send.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHATGPT_MODELS_URL } from "../src/ai/chatgpt";
import { CHATGPT_ORIGINS, DISCOVERY_URL, ISSUER, JWKS_URL, TOKEN_URL } from "../src/ai/chatgptAuth";
import { KEY_ACCESS_POINTS, KEY_ENTRIES, KEY_SETTINGS } from "../src/core/keys";
import { defaultSettings } from "../src/core/settings";
import type { AccessPoint } from "../src/core/types";
import { FakeBrowser, loadBackground } from "./helpers/browser";
import type { Background, FakeEvent } from "./helpers/browser";
import { accessPoint } from "./helpers/harness";
import { fakeFetch, jsonResponse, tokenFactory } from "./helpers/http";
import type { Handler, RecordedRequest } from "./helpers/http";

const COLLECTOR = "https://collector.example/v1";
const REVOKE_URL = "https://auth.openai.com/oauth/revoke";
const PLAN_SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Lets every pending promise callback run. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise((done) => setImmediate(done));
  }
}

/** A fake OpenAI: the token endpoint answers when the test releases it. */
async function fakeOpenAi() {
  const factory = await tokenFactory();
  const tokens = deferred<void>();
  // The server remembers the nonce of the authorization request.
  const session = { nonce: "" };
  const handlers: Record<string, Handler> = {
    [TOKEN_URL]: async (request) => {
      await tokens.promise;
      if (request.form.grant_type === "authorization_code") {
        const idToken = await factory.sign({
          iss: ISSUER,
          aud: request.form.client_id,
          exp: Math.floor(Date.now() / 1000) + 3600,
          nonce: session.nonce,
          sub: "user-1",
          email: "user@example.com",
        });
        return jsonResponse({ access_token: "access-new", refresh_token: "refresh-new", id_token: idToken, expires_in: 3600, scope: PLAN_SCOPES });
      }
      return jsonResponse({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, scope: PLAN_SCOPES });
    },
    [JWKS_URL]: () => jsonResponse(factory.jwks),
    [DISCOVERY_URL]: () => jsonResponse({ revocation_endpoint: REVOKE_URL }),
    [REVOKE_URL]: () => new Response("", { status: 200 }),
    [CHATGPT_MODELS_URL]: () => jsonResponse({ models: [{ slug: "gpt-6-luna", visibility: "list" }] }),
  };
  const http = fakeFetch(handlers);
  const revoked = (): string[] => http.requests.filter((request: RecordedRequest) => request.url === REVOKE_URL).map((request) => request.form.token ?? "");
  return { http, release: () => tokens.resolve(), handlers, revoked, session };
}

async function startSignIn(background: Background, session: { nonce: string }): Promise<string> {
  const started = await background.send("startSignIn", { accessPointId: null, openTab: true });
  if (!started.ok) {
    throw new Error(started.error);
  }
  const params = new URL(started.result.url).searchParams;
  session.nonce = params.get("nonce") ?? "";
  return `http://127.0.0.1:1455/auth/callback?code=code-1&state=${params.get("state") ?? ""}&client_id=oaiapp_new`;
}

function chatgptPoints(fake: FakeBrowser): AccessPoint[] {
  return ((fake.storage[KEY_ACCESS_POINTS] as AccessPoint[] | undefined) ?? []).filter((point) => point.type === "chatgpt");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function stored(fake: FakeBrowser): AccessPoint[] {
  return fake.storage[KEY_ACCESS_POINTS] as AccessPoint[];
}

describe("host permissions", () => {
  it("sends nothing to a host this computer never granted, also for Test and after enabling", async () => {
    // An access point as a Replace import leaves it: enabled, needing attention, no host permission.
    const imported = accessPoint({ id: "imported", type: "openai-chat", endpoint: COLLECTOR, apiKey: "", needsAttention: true });
    const fake = new FakeBrowser({ [KEY_SETTINGS]: defaultSettings(Date.now()), [KEY_ACCESS_POINTS]: [imported] });
    const http = fakeFetch(() => jsonResponse({ choices: [{ message: { content: "0.97" } }] }));
    const background = await loadBackground(fake, http.fetch);

    const test = await background.send("testAccessPoint", { id: "imported" });
    expect(test).toMatchObject({ ok: true, result: { ok: false } });
    expect(http.requests).toHaveLength(0);
    expect(stored(fake)[0]?.needsAttention).toBe(true);

    // The enable checkbox clears "needs attention", but still nothing is sent.
    await background.send("saveAccessPoint", {
      id: "imported",
      definition: { type: "openai-chat", name: "Primary", enabled: true, endpoint: COLLECTOR, model: "model-1" },
      apiKey: null,
    });
    expect(await background.send("testAccessPoint", { id: "imported" })).toMatchObject({ ok: true, result: { ok: false } });
    expect(http.requests).toHaveLength(0);

    // Saving in the editor after the consent dialog grants the host.
    fake.granted.add("https://collector.example/*");
    expect(await background.send("testAccessPoint", { id: "imported" })).toEqual({ ok: true, result: { ok: true, score: 0.97 } });
    expect(http.requests.map((request) => request.url)).toEqual([`${COLLECTOR}/chat/completions`]);
  });
});

describe("startup", () => {
  it("sweeps the screening folders when Thunderbird starts, not on every alarm", async () => {
    const settings = { ...defaultSettings(Date.now()), screeningFolders: [{ accountId: "account1", path: "/Screening" }] };
    const entries = [
      { list: "white", kind: "domain", value: "mycompany.example", scope: "all", source: "identity", addedAt: 1 },
      { list: "white", kind: "domain", value: "customer.example", scope: "all", source: "sent", addedAt: 2 },
    ];
    const fake = new FakeBrowser({ [KEY_SETTINGS]: settings, [KEY_ENTRIES]: entries });
    fake.folderMessages.set("f-screening", [FakeBrowser.header(7, "Anna <anna@customer.example>", "f-screening")]);
    const background = await loadBackground(fake, fakeFetch({}).fetch);
    background.fire(fake.api.alarms.onAlarm as unknown as FakeEvent, { name: "tick" });
    await settle();
    expect(fake.moves).toEqual([]);
    background.fire(fake.api.runtime.onStartup as unknown as FakeEvent);
    await settle();
    expect(fake.moves).toEqual([{ ids: [7], folderId: "f-inbox" }]);
  });
});

describe("incoming mail with unavailable headers", () => {
  it("scores a large message without the stalled headers and continues the queue", async () => {
    const now = Date.now();
    const settings = { ...defaultSettings(now - 1000), protection: true, protectionOnAt: now - 1000 };
    const point = accessPoint({ id: "ai", type: "openai-chat", endpoint: COLLECTOR });
    const entries = [{ list: "black", kind: "domain", value: "blocked.example", scope: "all", source: "manual", addedAt: now }];
    const fake = new FakeBrowser({ [KEY_SETTINGS]: settings, [KEY_ACCESS_POINTS]: [point], [KEY_ENTRIES]: entries });
    fake.granted.add("https://collector.example/*");
    fake.api.messages.getHeaders = vi.fn(() => new Promise<Record<string, string[]>>(() => undefined));
    const large = { ...FakeBrowser.header(1, "sender@large.example"), date: new Date(now), size: 6 * 1024 * 1024 };
    const next = { ...FakeBrowser.header(2, "sender@blocked.example"), date: new Date(now) };
    const http = fakeFetch(() => jsonResponse({ choices: [{ message: { content: "0.1" } }] }));
    const background = await loadBackground(fake, http.fetch);
    background.fire(fake.api.messages.onNewMailReceived as unknown as FakeEvent, large.folder, { id: null, messages: [large, next] });
    await settle();
    expect(http.requests).toHaveLength(0);
    expect(fake.moves).toEqual([]);

    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(http.requests).toHaveLength(1);
    expect(fake.moves).toEqual([{ ids: [2], folderId: "f-junk" }]);
  });
});

describe("reset", () => {
  it("ends the ChatGPT sessions it can still read before it deletes the data", async () => {
    const broken = { ...defaultSettings(Date.now()), cutoff: 7 };
    const points = [
      { id: "plan", type: "chatgpt", auth: { clientId: "oaiapp_1", refreshToken: "refresh-1", unexpected: true } },
      { id: "out", type: "chatgpt", auth: { clientId: "oaiapp_2", refreshToken: "" } },
      "not an access point",
    ];
    const fake = new FakeBrowser({ [KEY_SETTINGS]: broken, [KEY_ACCESS_POINTS]: points });
    const openai = await fakeOpenAi();
    const background = await loadBackground(fake, openai.http.fetch);
    expect(await background.send("getStatus", {})).toMatchObject({ ok: true, result: { fatal: expect.stringContaining("cutoff") } });
    expect(await background.send("resetData", {})).toEqual({ ok: true, result: null });
    expect(openai.revoked()).toEqual(["refresh-1"]);
    expect(fake.storage[KEY_ACCESS_POINTS]).toBeUndefined();
    expect(await background.send("getStatus", {})).toMatchObject({ ok: true, result: { fatal: null } });
  });
});

describe("scoring selected messages", () => {
  async function setup(selected: number) {
    const point = accessPoint({ id: "ai", type: "openai-chat", endpoint: "https://api.example.com/v1" });
    const fake = new FakeBrowser({ [KEY_SETTINGS]: defaultSettings(Date.now()), [KEY_ACCESS_POINTS]: [point] });
    fake.granted.add("https://api.example.com/*");
    fake.selected = Array.from({ length: selected }, (_, index) => FakeBrowser.header(index + 1, `Sender <s${index}@customer.example>`));
    const http = fakeFetch(() => jsonResponse({ choices: [{ message: { content: "0.3" } }] }));
    return { http, background: await loadBackground(fake, http.fetch) };
  }

  it("tells the popup how many messages are selected and scores them", async () => {
    const { http, background } = await setup(3);
    expect(await background.send("selection", { tabId: 1 })).toEqual({ ok: true, result: { count: 3, limit: 50, sender: null } });
    expect(await background.send("scoreSelected", { tabId: 1 })).toEqual({ ok: true, result: { selected: 3, scored: 3, failed: 0 } });
    expect(http.requests).toHaveLength(3);
  });

  it("refuses more than 50 messages before anything is sent", async () => {
    const { http, background } = await setup(5000);
    expect(await background.send("selection", { tabId: 1 })).toEqual({ ok: true, result: { count: 51, limit: 50, sender: null } });
    expect(await background.send("scoreSelected", { tabId: 1 })).toEqual({ ok: false, error: "popupScoreTooMany(50)" });
    expect(http.requests).toHaveLength(0);
  });
});

describe("block and trust without shortcuts", () => {
  async function setup(selected: tb.MessageHeader[]) {
    const fake = new FakeBrowser({ [KEY_SETTINGS]: defaultSettings(Date.now()) });
    fake.selected = selected;
    fake.folderMessages.set("f-inbox", selected);
    const background = await loadBackground(fake, fakeFetch({}).fetch);
    await settle();
    return { fake, background };
  }

  it("tells the popup whose message is selected and what the domain buttons would add", async () => {
    const { background } = await setup([FakeBrowser.header(1, "Mike <mike@mail.outreach.example>")]);
    expect(await background.send("selection", { tabId: 1 })).toEqual({
      ok: true,
      result: {
        count: 1,
        limit: 50,
        sender: { address: "mike@mail.outreach.example", via: "", own: false, domainTarget: { kind: "domain", value: "outreach.example" } },
      },
    });
  });

  it("runs the command of a popup button on the selection and answers with what was done, without a notification", async () => {
    const { fake, background } = await setup([FakeBrowser.header(1, "mike@outreach.example"), FakeBrowser.header(2, "anna@outreach.example")]);
    expect(await background.send("runCommand", { command: "block-domain", tabId: 1 })).toEqual({
      ok: true,
      result: { lines: ["notifyBlocked(outreach.example)", "notifyMovedToJunk(2)"], failed: false },
    });
    expect(fake.moves).toEqual([{ ids: [1, 2], folderId: "f-junk" }]);
    expect(fake.storage[KEY_ENTRIES]).toMatchObject([{ list: "black", kind: "domain", value: "outreach.example", source: "manual" }]);
    expect(fake.notifications).toEqual([]);
  });

  it("refuses anything but the four commands, and says so when nothing is selected", async () => {
    const { fake, background } = await setup([]);
    expect(await background.send("runCommand", { command: "block-address", tabId: 1 })).toEqual({
      ok: true,
      result: { lines: ["popupNothingSelected"], failed: true },
    });
    expect(await background.send("runCommand", { command: "delete-everything" as never, tabId: 1 })).toMatchObject({ ok: false });
    expect(fake.moves).toEqual([]);
  });

  it("offers the four commands in a Block Spam submenu of the message list", async () => {
    const { fake } = await setup([]);
    expect(fake.menuItems).toEqual([
      { id: "block-spam-menu", title: "extensionName", contexts: ["message_list"] },
      { id: "block-address", parentId: "block-spam-menu", title: "cmdBlockAddress", contexts: ["message_list"] },
      { id: "block-domain", parentId: "block-spam-menu", title: "cmdBlockDomain", contexts: ["message_list"] },
      { id: "block-spam-separator", parentId: "block-spam-menu", type: "separator", contexts: ["message_list"] },
      { id: "trust-address", parentId: "block-spam-menu", title: "cmdTrustAddress", contexts: ["message_list"] },
      { id: "trust-domain", parentId: "block-spam-menu", title: "cmdTrustDomain", contexts: ["message_list"] },
    ]);
  });

  it("runs a menu command on the messages the menu was opened for and confirms with a notification", async () => {
    const { fake, background } = await setup([]);
    const clicked = [FakeBrowser.header(5, "friend@gmail.com", "f-junk"), FakeBrowser.header(6, "anna@customer.example", "f-junk")];
    background.fire(fake.api.menus.onClicked as unknown as FakeEvent, { menuItemId: "trust-domain", selectedMessages: { id: null, messages: clicked } });
    await settle();
    expect(fake.moves).toEqual([{ ids: [5, 6], folderId: "f-inbox" }]);
    expect(fake.storage[KEY_ENTRIES]).toMatchObject([
      { list: "white", kind: "address", value: "friend@gmail.com", source: "manual" },
      { list: "white", kind: "domain", value: "customer.example", source: "manual" },
    ]);
    expect(fake.notifications).toEqual(["notifyTrusted(friend@gmail.com, customer.example)\nnotifyMovedToInbox(2)"]);

    // Anything that is not one of the commands is ignored.
    background.fire(fake.api.menus.onClicked as unknown as FakeEvent, { menuItemId: "block-spam-menu", selectedMessages: { id: null, messages: clicked } });
    await settle();
    expect(fake.notifications).toHaveLength(1);
  });
});

describe("list entries from the settings page", () => {
  async function setup(entries: unknown[] = []) {
    const fake = new FakeBrowser({ [KEY_SETTINGS]: defaultSettings(Date.now()), [KEY_ENTRIES]: entries });
    const background = await loadBackground(fake, fakeFetch({}).fetch);
    return { fake, background };
  }

  it("adds an entry whose kind follows from the value", async () => {
    const { fake, background } = await setup();
    expect(await background.send("addEntry", { list: "black", value: "Mail.Outreach.example", scope: "all" })).toEqual({
      ok: true,
      result: { value: "outreach.example", kind: "domain", list: "black", result: "added" },
    });
    expect(await background.send("addEntry", { list: "white", value: "Anna@Customer.example", scope: "all" })).toMatchObject({
      ok: true,
      result: { value: "anna@customer.example", kind: "address", list: "white" },
    });
    expect(fake.storage[KEY_ENTRIES]).toHaveLength(2);
  });

  it("answers a value that is neither an address nor a domain with a code for the page to translate", async () => {
    const { fake, background } = await setup();
    expect(await background.send("addEntry", { list: "white", value: "not an address", scope: "all" })).toEqual({
      ok: false,
      error: "value: not a domain",
      code: "entry-invalid",
    });
    expect(fake.storage[KEY_ENTRIES]).toEqual([]);
  });

  it("puts removed entries back exactly as they were", async () => {
    const learned = { list: "white", kind: "domain", value: "customer.example", scope: "all", source: "scan", addedAt: 123 };
    const { fake, background } = await setup([learned]);
    expect(await background.send("removeEntries", { keys: ["domain all customer.example"] })).toEqual({ ok: true, result: { removed: 1 } });
    expect(fake.storage[KEY_ENTRIES]).toEqual([]);
    expect(await background.send("restoreEntries", { entries: [learned as never] })).toEqual({ ok: true, result: { restored: 1 } });
    expect(fake.storage[KEY_ENTRIES]).toEqual([learned]);
  });

  it("restores nothing that is not a valid entry", async () => {
    const { fake, background } = await setup();
    const broken = { list: "white", kind: "domain", value: "Not Normalized.example", scope: "all", source: "scan", addedAt: 1 };
    expect(await background.send("restoreEntries", { entries: [broken as never] })).toMatchObject({ ok: false });
    expect(await background.send("restoreEntries", { entries: "all of them" as never })).toMatchObject({ ok: false });
    expect(fake.storage[KEY_ENTRIES]).toEqual([]);
  });
});

describe("undoing a decision from the log", () => {
  const spam = {
    time: 1,
    accountId: "account1",
    account: "Work",
    sender: "growth@leadgen.example",
    via: "",
    subject: "Quick question",
    outcome: "spam",
    action: "junk",
    score: 0.97,
    accessPoint: "Jev",
    reason: "ai-above",
    detail: "leadgen.example [all]",
    observed: false,
    test: false,
    messageId: "msg-7@test",
  } as const;

  async function setup() {
    const blocked = { list: "black", kind: "domain", value: "leadgen.example", scope: "all", source: "ai", addedAt: 5 };
    const fake = new FakeBrowser({ [KEY_SETTINGS]: defaultSettings(Date.now()), [KEY_ENTRIES]: [blocked] });
    fake.folderMessages.set("f-junk", [FakeBrowser.header(7, "Growth <growth@leadgen.example>", "f-junk")]);
    const background = await loadBackground(fake, fakeFetch({}).fetch);
    return { fake, background, blocked };
  }

  it("trusts the sender of the entry, moves its message back to the Inbox, and can be taken back", async () => {
    const { fake, background, blocked } = await setup();
    const done = await background.send("logAction", { entry: spam, action: "trust" });
    expect(done).toMatchObject({
      ok: true,
      result: { list: "white", target: { kind: "domain", value: "leadgen.example" }, scope: "all", result: "moved", move: "moved" },
    });
    expect(fake.storage[KEY_ENTRIES]).toMatchObject([{ list: "white", kind: "domain", value: "leadgen.example", source: "manual" }]);
    expect(fake.moves).toEqual([{ ids: [7], folderId: "f-inbox" }]);

    if (!done.ok) {
      throw new Error(done.error);
    }
    expect(await background.send("undoLogAction", { undo: done.result.undo })).toEqual({ ok: true, result: { move: "moved", failure: "" } });
    expect(fake.storage[KEY_ENTRIES]).toEqual([blocked]);
    expect(fake.moves[1]).toEqual({ ids: [7], folderId: "f-junk" });
  });

  it("still changes the lists when the message is gone, and says that it was not found", async () => {
    const { fake, background } = await setup();
    fake.folderMessages.clear();
    expect(await background.send("logAction", { entry: spam, action: "trust" })).toMatchObject({ ok: true, result: { result: "moved", move: "not-found" } });
    expect(fake.storage[KEY_ENTRIES]).toMatchObject([{ list: "white", value: "leadgen.example" }]);
    expect(fake.moves).toEqual([]);
  });

  it("refuses an unknown action, an entry that is not a log entry and an undo that is not one", async () => {
    const { fake, background, blocked } = await setup();
    expect(await background.send("logAction", { entry: spam, action: "delete" as never })).toMatchObject({ ok: false });
    expect(await background.send("logAction", { entry: { ...spam, outcome: "deleted" } as never, action: "trust" })).toMatchObject({ ok: false });
    expect(await background.send("undoLogAction", { undo: { accountId: "account1", messageId: "m", remove: [], restore: [{ list: "white" }], move: null } as never })).toMatchObject({ ok: false });
    expect(fake.storage[KEY_ENTRIES]).toEqual([blocked]);
    expect(fake.moves).toEqual([]);
  });

  it("answers an action on one of the user's own addresses with a code", async () => {
    const { background } = await setup();
    expect(await background.send("logAction", { entry: { ...spam, outcome: "trusted", action: "none", sender: "me@mycompany.example" }, action: "block" })).toMatchObject({
      ok: false,
      code: "own-address",
    });
  });
});

describe("the models of a service that is not saved yet", () => {
  const draft = { type: "openai-chat", name: "New", enabled: true, endpoint: COLLECTOR, model: "" } as const;

  it("asks the host of the unsaved definition with the key being typed, and stores nothing", async () => {
    const fake = new FakeBrowser({ [KEY_SETTINGS]: defaultSettings(Date.now()) });
    fake.granted.add("https://collector.example/*");
    const http = fakeFetch(() => jsonResponse({ data: [{ id: "model-a" }, { id: "models/model-b" }] }));
    const background = await loadBackground(fake, http.fetch);
    expect(await background.send("listModelsFor", { id: null, definition: draft, apiKey: "typed-key" })).toEqual({
      ok: true,
      result: [
        { id: "model-a", label: "model-a" },
        { id: "model-b", label: "model-b" },
      ],
    });
    expect(http.requests.map((request) => [request.url, request.headers.authorization])).toEqual([[`${COLLECTOR}/models`, "Bearer typed-key"]]);
    expect(fake.storage[KEY_ACCESS_POINTS]).toBeUndefined();
  });

  it("sends nothing to a host this computer has not granted", async () => {
    const fake = new FakeBrowser({ [KEY_SETTINGS]: defaultSettings(Date.now()) });
    const http = fakeFetch(() => jsonResponse({ data: [{ id: "model-a" }] }));
    const background = await loadBackground(fake, http.fetch);
    expect(await background.send("listModelsFor", { id: null, definition: draft, apiKey: "typed-key" })).toMatchObject({ ok: false });
    expect(http.requests).toHaveLength(0);
  });

  it("uses the stored key of the service being edited when none was typed", async () => {
    const saved = accessPoint({ id: "saved", type: "openai-chat", endpoint: COLLECTOR, apiKey: "stored-key" });
    const fake = new FakeBrowser({ [KEY_SETTINGS]: defaultSettings(Date.now()), [KEY_ACCESS_POINTS]: [saved] });
    fake.granted.add("https://collector.example/*");
    const http = fakeFetch(() => jsonResponse({ data: [{ id: "model-a" }] }));
    const background = await loadBackground(fake, http.fetch);
    await background.send("listModelsFor", { id: "saved", definition: draft, apiKey: null });
    expect(http.requests[0]?.headers.authorization).toBe("Bearer stored-key");
    // The stored service is not changed by looking at a draft of it.
    expect(stored(fake)).toEqual([saved]);
    expect(await background.send("listModelsFor", { id: "gone", definition: draft, apiKey: null })).toEqual({ ok: false, error: "errorAccessPointGone" });
  });
});

describe("showing something in the settings page from the popup", () => {
  const target = { pane: "log", logKey: "entry-1" };

  it("tells an open settings page at once and hands the target to a page that opens, once", async () => {
    const fake = new FakeBrowser({ [KEY_SETTINGS]: defaultSettings(Date.now()) });
    const background = await loadBackground(fake, fakeFetch({}).fetch);
    expect(await background.send("takeSettingsTarget", {})).toEqual({ ok: true, result: { target: null } });
    expect(await background.send("showInSettings", target)).toEqual({ ok: true, result: null });
    expect(fake.pageEvents).toEqual([{ blockSpamEvent: "show", target }]);
    expect(await background.send("takeSettingsTarget", {})).toEqual({ ok: true, result: { target } });
    expect(await background.send("takeSettingsTarget", {})).toEqual({ ok: true, result: { target: null } });
  });

  it("forgets the target when no page asked for it within half a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = new FakeBrowser({ [KEY_SETTINGS]: defaultSettings(Date.now()) });
    const background = await loadBackground(fake, fakeFetch({}).fetch);
    await background.send("showInSettings", { pane: "overview", logKey: null });
    vi.setSystemTime(Date.now() + 31_000);
    expect(await background.send("takeSettingsTarget", {})).toEqual({ ok: true, result: { target: null } });
  });

  it("refuses a target that names no pane", async () => {
    const fake = new FakeBrowser({ [KEY_SETTINGS]: defaultSettings(Date.now()) });
    const background = await loadBackground(fake, fakeFetch({}).fetch);
    expect(await background.send("showInSettings", { pane: 7, logKey: null } as never)).toMatchObject({ ok: false });
    expect(fake.pageEvents).toEqual([]);
  });
});

describe("import", () => {
  it("answers a file that is not valid with a code, so the page can say so in the user's language", async () => {
    const fake = new FakeBrowser({ [KEY_SETTINGS]: defaultSettings(Date.now()) });
    const background = await loadBackground(fake, fakeFetch({}).fetch);
    const reply = await background.send("importData", { file: { format: "something else" }, mode: "merge" });
    expect(reply).toMatchObject({ ok: false, code: "import-invalid" });
    expect(fake.storage[KEY_ENTRIES]).toBeUndefined();
  });
});

describe("ChatGPT sign-in", () => {
  async function setup() {
    const fake = new FakeBrowser();
    for (const origin of CHATGPT_ORIGINS) {
      fake.granted.add(origin);
    }
    const openai = await fakeOpenAi();
    const background = await loadBackground(fake, openai.http.fetch);
    return { fake, openai, background };
  }

  it("exchanges a code once when the capture and a pasted address both arrive", async () => {
    const { fake, openai, background } = await setup();
    const callback = await startSignIn(background, openai.session);
    const captured = background.send("finishSignIn", { url: callback });
    const pasted = background.send("finishSignIn", { url: callback });
    await settle();
    openai.release();
    expect(await captured).toEqual({ ok: true, result: null });
    expect(await pasted).toEqual({ ok: true, result: null });
    expect(openai.http.requests.filter((request) => request.url === TOKEN_URL)).toHaveLength(1);
    expect(chatgptPoints(fake)).toHaveLength(1);
    expect(chatgptPoints(fake)[0]).toMatchObject({ enabled: true, model: "gpt-6-luna", auth: { refreshToken: "refresh-new" } });
  });

  it("creates nothing and ends the new session when the sign-in is cancelled during the exchange", async () => {
    const { fake, openai, background } = await setup();
    const callback = await startSignIn(background, openai.session);
    const finishing = background.send("finishSignIn", { url: callback });
    await settle();
    expect(await background.send("cancelSignIn", {})).toEqual({ ok: true, result: null });
    openai.release();
    expect(await finishing).toEqual({ ok: false, error: "signInNoneInProgress" });
    await settle();
    expect(chatgptPoints(fake)).toEqual([]);
    expect(openai.revoked()).toEqual(["refresh-new"]);
    // The cancelled attempt leaves no error on the sign-in panel.
    expect(await background.send("getStatus", {})).toMatchObject({ ok: true, result: { signIn: { url: null, error: "" } } });
  });

  it("does not let a failing old attempt end the attempt that replaced it", async () => {
    const { openai, background } = await setup();
    openai.handlers[TOKEN_URL] = async () => {
      await new Promise<void>((done) => {
        openai.release = done;
      });
      return jsonResponse({ error: "invalid_grant" }, 400);
    };
    const oldCallback = await startSignIn(background, openai.session);
    const finishing = background.send("finishSignIn", { url: oldCallback });
    await settle();
    await startSignIn(background, openai.session);
    openai.release();
    expect(await finishing).toMatchObject({ ok: false });
    const status = await background.send("getStatus", {});
    expect(status).toMatchObject({ ok: true, result: { signIn: { error: "" } } });
    expect(status.ok && status.result.signIn.url).not.toBeNull();
  });

  it("ends both sessions when Sign out comes while a token refresh is running", async () => {
    const signedIn = accessPoint({
      id: "plan",
      type: "chatgpt",
      endpoint: "https://api.openai.com/v1/responses",
      model: "gpt-6-luna",
      apiKey: "",
      auth: {
        clientId: "oaiapp_1",
        subject: "user-1",
        email: "user@example.com",
        idToken: "id-1",
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: Date.now() - 1,
        earliestRefreshAt: 0,
        scopes: PLAN_SCOPES.split(" "),
      },
    });
    const fake = new FakeBrowser({ [KEY_SETTINGS]: defaultSettings(Date.now()), [KEY_ACCESS_POINTS]: [signedIn] });
    for (const origin of CHATGPT_ORIGINS) {
      fake.granted.add(origin);
    }
    const openai = await fakeOpenAi();
    const background = await loadBackground(fake, openai.http.fetch);
    const test = background.send("testAccessPoint", { id: "plan" });
    await settle();
    expect(await background.send("signOut", { id: "plan" })).toEqual({ ok: true, result: { revocationConfirmed: true } });
    openai.release();
    expect(await test).toMatchObject({ ok: true, result: { ok: false } });
    await settle();
    expect(chatgptPoints(fake)[0]?.auth).toMatchObject({ refreshToken: "", accessToken: "" });
    expect(openai.revoked().sort()).toEqual(["refresh-1", "refresh-2"]);
    expect(openai.http.requests.some((request) => request.url.endsWith("/v1/responses"))).toBe(false);
  });
});
