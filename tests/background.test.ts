// The background page, loaded against a fake of the Thunderbird API and driven
// through the same requests the settings page and the popup send.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHATGPT_MODELS_URL } from "../src/ai/chatgpt";
import { CHATGPT_ORIGINS, DISCOVERY_URL, ISSUER, JWKS_URL, TOKEN_URL } from "../src/ai/chatgptAuth";
import { KEY_ACCESS_POINTS, KEY_ATTENTION_NOTIFIED, KEY_ENTRIES, KEY_LAST_COMMAND, KEY_PROTECTION_WISH, KEY_SETTINGS } from "../src/core/keys";
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

async function startSignIn(background: Background, session: { nonce: string }, afterScan: boolean | null = null): Promise<string> {
  const started = await background.send("startSignIn", { accessPointId: null, openTab: true, afterScan });
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
        sender: {
          address: "mike@mail.outreach.example",
          via: "",
          own: false,
          domainTarget: { kind: "domain", value: "outreach.example" },
          deciding: null,
          accountId: "account1",
          messageId: "msg-1@test",
          unchanged: [],
          // What each button would do, for its tooltip.
          effects: {
            "block-address": { target: { kind: "address", value: "mike@mail.outreach.example" }, change: "added", lifted: [], moves: true },
            "block-domain": { target: { kind: "domain", value: "outreach.example" }, change: "added", lifted: [], moves: true },
            "trust-address": { target: { kind: "address", value: "mike@mail.outreach.example" }, change: "added", lifted: [], moves: false },
            "trust-domain": { target: { kind: "domain", value: "outreach.example" }, change: "added", lifted: [], moves: false },
          },
        },
      },
    });
  });

  it("runs the command of a popup button on the selection and answers with what was done, without a notification", async () => {
    const { fake, background } = await setup([FakeBrowser.header(1, "mike@outreach.example"), FakeBrowser.header(2, "anna@outreach.example")]);
    expect(await background.send("runCommand", { command: "block-domain", tabId: 1 })).toMatchObject({
      ok: true,
      result: { source: "popup", lines: ["notifyBlocked(outreach.example)", "notifyMovedToJunk(2)"], failed: false, undoable: true },
    });
    expect(fake.moves).toEqual([{ ids: [1, 2], folderId: "f-junk" }]);
    expect(fake.storage[KEY_ENTRIES]).toMatchObject([{ list: "black", kind: "domain", value: "outreach.example", source: "manual" }]);
    expect(fake.notifications).toEqual([]);
  });

  it("refuses anything but the four commands, and says so when nothing is selected", async () => {
    const { fake, background } = await setup([]);
    expect(await background.send("runCommand", { command: "block-address", tabId: 1 })).toMatchObject({
      ok: true,
      result: { lines: ["popupNothingSelected"], failed: true, undoable: false },
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
    // The notification also says where the command can be undone.
    expect(fake.notifications).toEqual(["notifyTrusted(friend@gmail.com, customer.example)\nnotifyMovedToInbox(2)\nnotifyUndoHint"]);

    // Anything that is not one of the commands is ignored.
    background.fire(fake.api.menus.onClicked as unknown as FakeEvent, { menuItemId: "block-spam-menu", selectedMessages: { id: null, messages: clicked } });
    await settle();
    expect(fake.notifications).toHaveLength(1);
  });
});

describe("undoing a command made by hand", () => {
  async function setup(entries: unknown[] = []) {
    const fake = new FakeBrowser({ [KEY_SETTINGS]: defaultSettings(Date.now()), [KEY_ENTRIES]: entries });
    const message = FakeBrowser.header(1, "Mike <mike@outreach.example>");
    fake.selected = [message];
    fake.folderMessages.set("f-inbox", [message]);
    const background = await loadBackground(fake, fakeFetch({}).fetch);
    await settle();
    return { fake, background };
  }

  it("offers Undo in the popup right after a button, and takes the command back exactly", async () => {
    const learned = { list: "white", kind: "domain", value: "outreach.example", scope: "all", source: "sent", addedAt: 5 };
    const { fake, background } = await setup([learned]);
    const done = await background.send("runCommand", { command: "block-address", tabId: 1 });
    if (!done.ok) {
      throw new Error(done.error);
    }
    expect(done.result.undoable).toBe(true);
    // An address entry beats the entry of its domain, which stays as it is.
    expect(fake.storage[KEY_ENTRIES]).toMatchObject([learned, { list: "black", kind: "address", value: "mike@outreach.example" }]);
    expect(fake.moves).toEqual([{ ids: [1], folderId: "f-junk" }]);

    expect(await background.send("undoCommand", { id: done.result.id })).toEqual({
      ok: true,
      result: { lines: ["commandUndone", "commandUndoMoved(1)"], failed: false },
    });
    expect(fake.storage[KEY_ENTRIES]).toEqual([learned]);
    expect(fake.moves[1]).toEqual({ ids: [1], folderId: "f-inbox" });
    // Taken back once: there is nothing left to undo.
    expect(await background.send("lastCommand", {})).toEqual({ ok: true, result: { command: null } });
    expect(await background.send("undoCommand", { id: done.result.id })).toMatchObject({ ok: false, code: "undo-gone" });
  });

  it("keeps the command of a shortcut for the next time the popup opens, also after the background page was restarted", async () => {
    const { fake, background } = await setup();
    background.fire(fake.api.commands.onCommand as unknown as FakeEvent, "block-domain", { id: 1, type: "mail", active: true });
    await settle();
    expect(fake.notifications).toEqual(["notifyBlocked(outreach.example)\nnotifyMovedToJunk(1)\nnotifyUndoHint"]);

    // A background page that was suspended keeps nothing in memory.
    const restarted = await loadBackground(fake, fakeFetch({}).fetch);
    const last = await restarted.send("lastCommand", {});
    expect(last).toMatchObject({ ok: true, result: { command: { source: "shortcut", lines: ["notifyBlocked(outreach.example)", "notifyMovedToJunk(1)"], undoable: true } } });
    if (!last.ok || last.result.command === null) {
      throw new Error("no command");
    }
    expect(await restarted.send("undoCommand", { id: last.result.command.id })).toMatchObject({ ok: true, result: { failed: false } });
    expect(fake.storage[KEY_ENTRIES]).toEqual([]);
    expect(fake.moves.at(-1)).toEqual({ ids: [1], folderId: "f-inbox" });
  });

  it("lets a command that changed nothing leave the one before it in place, and forgets a dismissed one", async () => {
    const { fake, background } = await setup();
    const first = await background.send("runCommand", { command: "block-address", tabId: 1 });
    if (!first.ok) {
      throw new Error(first.error);
    }
    // The same command again: the address is blocked and the message is in Junk already.
    fake.selected = [FakeBrowser.header(1, "Mike <mike@outreach.example>", "f-junk")];
    expect(await background.send("runCommand", { command: "block-address", tabId: 1 })).toMatchObject({ ok: true, result: { undoable: false } });
    expect(await background.send("lastCommand", {})).toMatchObject({ ok: true, result: { command: { id: first.result.id } } });

    // Dismissing another command than the last one does nothing.
    await background.send("dismissCommand", { id: "something-else" });
    expect(fake.storage[KEY_LAST_COMMAND]).toBeDefined();
    await background.send("dismissCommand", { id: first.result.id });
    expect(fake.storage[KEY_LAST_COMMAND]).toBeUndefined();
    expect(fake.storage[KEY_ENTRIES]).toMatchObject([{ list: "black", value: "mike@outreach.example" }]);
  });

  it("ignores a stored command that is not one", async () => {
    const { fake, background } = await setup();
    fake.storage[KEY_LAST_COMMAND] = { id: "x", lines: "not a list" };
    expect(await background.send("lastCommand", {})).toEqual({ ok: true, result: { command: null } });
    expect(await background.send("undoCommand", { id: "x" })).toMatchObject({ ok: false, code: "undo-gone" });
  });
});

describe("problems on the toolbar button", () => {
  const rejected = (partial: Partial<AccessPoint> = {}): AccessPoint =>
    accessPoint({ id: "openai", name: "OpenAI", type: "openai-chat", endpoint: "https://api.example.com/v1", needsAttention: true, lastError: "HTTP 401", ...partial });

  async function setup(settings: Record<string, unknown>, points: AccessPoint[], extra: Record<string, unknown> = {}) {
    const learned = { list: "white", kind: "domain", value: "customer.example", scope: "all", source: "sent", addedAt: 5 };
    const fake = new FakeBrowser({ [KEY_SETTINGS]: { ...defaultSettings(Date.now()), ...settings }, [KEY_ACCESS_POINTS]: points, [KEY_ENTRIES]: [learned], ...extra });
    fake.granted.add("https://api.example.com/*");
    const background = await loadBackground(fake, fakeFetch({}).fetch);
    await settle();
    return { fake, background };
  }

  it("shows a badge with the number of problems in the title while protection is on", async () => {
    const { fake, background } = await setup({ protection: true, protectionOnAt: 1 }, [rejected()]);
    // One cause is one problem. The tooltip counts the problems and names them.
    expect(fake.badge).toMatchObject({ text: "!", title: "badgeProblems_one(1, cause_attention(OpenAI))" });
    expect(fake.badge.color).not.toBeNull();

    // Editing the service clears the problem, and the badge with it.
    await background.send("saveAccessPoint", {
      id: "openai",
      definition: { type: "openai-chat", name: "OpenAI", enabled: true, endpoint: "https://api.example.com/v1", model: "model-1" },
      apiKey: "sk-new",
    });
    await settle();
    expect(fake.badge).toMatchObject({ text: "", title: "tooltip_on" });
  });

  it("shows no badge while protection is off, and one for stored data that is not valid", async () => {
    const off = await setup({ protection: false }, [rejected()]);
    expect(off.fake.badge).toMatchObject({ text: "", title: "tooltip_off" });
    await off.background.send("setProtection", { on: true });
    await settle();
    expect(off.fake.badge.text).toBe("!");

    const broken = await setup({ cutoff: 7 }, []);
    expect(broken.fake.badge).toMatchObject({ text: "!", title: "tooltip_invalid" });
  });

  it("carries the state of protection as the tooltip of the button, without a badge while nothing is wrong", async () => {
    const observing = await setup({ protection: true, protectionOnAt: 1, observation: true }, []);
    expect(observing.fake.badge).toMatchObject({ text: "", title: "tooltip_observing" });
    await observing.background.send("updateSettings", { patch: { observation: false } });
    await settle();
    expect(observing.fake.badge).toMatchObject({ text: "", title: "tooltip_on" });
  });

  it("counts one problem for several services that need the same thing, and announces them together", async () => {
    const second = rejected({ id: "gemini", name: "Gemini" });
    const missing = rejected({ id: "local", name: "Local", apiKey: "", lastError: "" });
    const { fake, background } = await setup({ protection: true, protectionOnAt: 1 }, [rejected(), second, missing]);
    expect(fake.badge).toMatchObject({ text: "!", title: "badgeProblems_many(2, cause_attention(OpenAI, Gemini); cause_attention(Local))" });
    background.fire(fake.api.alarms.onAlarm as unknown as FakeEvent, { name: "tick" });
    await settle();
    expect(fake.notifications).toEqual(["warnNeedsAttentionMany(OpenAI, Gemini) remedyMany_key_rejected", "warnNeedsAttention(Local) remedy_key_missing"]);
    expect(fake.notificationIds).toEqual(["attention:openai,gemini", "attention:local"]);
    expect(fake.storage[KEY_ATTENTION_NOTIFIED]).toEqual(["openai", "gemini", "local"]);
  });

  it("announces a service once when it first needs attention, and again only after it has worked", async () => {
    const { fake, background } = await setup({ protection: true, protectionOnAt: 1 }, [rejected()]);
    // What was wrong when the page was loaded is on the badge, not announced.
    expect(fake.notifications).toEqual([]);
    background.fire(fake.api.alarms.onAlarm as unknown as FakeEvent, { name: "tick" });
    await settle();
    expect(fake.notifications).toEqual(["warnNeedsAttention(OpenAI) remedy_key_rejected"]);
    expect(fake.notificationIds).toEqual(["attention:openai"]);
    expect(fake.storage[KEY_ATTENTION_NOTIFIED]).toEqual(["openai"]);

    background.fire(fake.api.alarms.onAlarm as unknown as FakeEvent, { name: "tick" });
    await settle();
    expect(fake.notifications).toHaveLength(1);

    // The user enters a new key: the service is no longer marked, and a later rejection is news again.
    await background.send("saveAccessPoint", {
      id: "openai",
      definition: { type: "openai-chat", name: "OpenAI", enabled: true, endpoint: "https://api.example.com/v1", model: "model-1" },
      apiKey: "sk-new",
    });
    await settle();
    expect(fake.storage[KEY_ATTENTION_NOTIFIED]).toEqual([]);
  });

  it("does not announce what the user did on the page, nor anything while protection is off", async () => {
    const quiet = await setup({ protection: false }, [rejected()]);
    quiet.background.fire(quiet.fake.api.alarms.onAlarm as unknown as FakeEvent, { name: "tick" });
    await settle();
    expect(quiet.fake.notifications).toEqual([]);

    const auth = { clientId: "c", subject: "s", email: "", idToken: "", accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000, earliestRefreshAt: 0, scopes: [] };
    const plan = accessPoint({ id: "plan", name: "ChatGPT plan", type: "chatgpt", auth });
    const signedOut = await setup({ protection: true, protectionOnAt: 1 }, [plan]);
    await signedOut.background.send("signOut", { id: "plan" });
    await settle();
    signedOut.background.fire(signedOut.fake.api.alarms.onAlarm as unknown as FakeEvent, { name: "tick" });
    await settle();
    expect(signedOut.fake.badge.text).toBe("!");
    expect(signedOut.fake.notifications).toEqual([]);
  });

  it("leads from the notification to the warnings: the open settings page comes to the front, or the page is opened", async () => {
    const { fake, background } = await setup({ protection: true, protectionOnAt: 1 }, [rejected()]);
    background.fire(fake.api.notifications.onClicked as unknown as FakeEvent, "attention:openai");
    await settle();
    expect(fake.optionsPageOpened).toBe(1);
    expect(await background.send("takeSettingsTarget", {})).toEqual({ ok: true, result: { target: { pane: "overview", logKey: null } } });

    fake.optionsTab = { id: 7, windowId: 1 };
    background.fire(fake.api.notifications.onClicked as unknown as FakeEvent, "attention:openai");
    await settle();
    expect(fake.optionsPageOpened).toBe(1);
    expect(fake.activatedTabs).toEqual([7]);
    // Any other notification is left alone.
    background.fire(fake.api.notifications.onClicked as unknown as FakeEvent, "notification");
    await settle();
    expect(fake.activatedTabs).toEqual([7]);
  });
});

/** The wish as the status reports it while nothing waits and nothing is left to say. */
const NOTHING_WAITS = { waiting: false, outcome: null, services: [], servicesOutcome: null, noVerdict: null, noVerdictOutcome: null };

describe("protection that waits for the scan of the sent mail", () => {
  type Settings = ReturnType<typeof defaultSettings>;
  const settingsOf = (fake: FakeBrowser): Settings => fake.storage[KEY_SETTINGS] as Settings;
  const sent = (id: number): tb.MessageHeader => ({ ...FakeBrowser.header(id, "Me <me@mycompany.example>", "f-sent"), recipients: [`person${id}@customer${id}.example`] });

  async function setup(extra: Record<string, unknown> = {}, messages = 3) {
    const jev = accessPoint({ id: "jev", name: "Jev" });
    const fake = new FakeBrowser({ [KEY_SETTINGS]: defaultSettings(Date.now()), [KEY_ACCESS_POINTS]: [jev], ...extra });
    fake.folderMessages.set(
      "f-sent",
      Array.from({ length: messages }, (_, index) => sent(index + 1)),
    );
    const background = await loadBackground(fake, fakeFetch({}).fetch);
    await settle();
    return { fake, background };
  }

  const status = async (background: Background) => {
    const reply = await background.send("getStatus", {});
    if (!reply.ok) {
      throw new Error(reply.error);
    }
    return reply.result;
  };

  it("scans first and then switches protection on by itself, from the moment the scan has ended", async () => {
    const { fake, background } = await setup();
    const asked = Date.now();
    expect(await background.send("protectAfterScan", {})).toEqual({ ok: true, result: null });
    // Stored at once, so the wish survives a closed settings page and a restart.
    expect(fake.storage[KEY_PROTECTION_WISH]).toMatchObject({ waiting: { from: null, to: null }, outcome: null });
    expect((await status(background)).wish.waiting).toBe(true);
    expect(settingsOf(fake).protection).toBe(false);
    expect(fake.badge.title).toBe("tooltip_waiting");

    await settle();
    const after = await status(background);
    expect(after.scan).toMatchObject({ running: false, scanned: 3 });
    expect(after.wish).toMatchObject({ waiting: false, outcome: { kind: "on", scanned: 3 } });
    expect(settingsOf(fake).protection).toBe(true);
    // The moment protection really went on is the one that counts for mail that is never touched.
    expect(settingsOf(fake).protectionOnAt).toBeGreaterThanOrEqual(asked);
    // The settings page is not in front: a notification says what happened.
    expect(fake.notifications).toEqual(["wishOn"]);
    expect(fake.badge.title).toBe("tooltip_on");
  });

  it("waits for a scan that is already running instead of starting a second one", async () => {
    const { fake, background } = await setup();
    const from = Date.UTC(2020, 0, 1);
    await background.send("startScan", { from, to: null });
    await background.send("protectAfterScan", {});
    // The dates of the running scan are kept with the wish, for a restart of Thunderbird.
    expect(fake.storage[KEY_PROTECTION_WISH]).toMatchObject({ waiting: { from, to: null } });
    await settle();
    expect(settingsOf(fake).protection).toBe(true);
  });

  it("switches protection on after a scan that read no message, and says that it found none", async () => {
    const { fake, background } = await setup({}, 0);
    await background.send("protectAfterScan", {});
    await settle();
    expect(settingsOf(fake).protection).toBe(true);
    expect((await status(background)).wish.outcome).toMatchObject({ kind: "on", scanned: 0 });
    expect(fake.notifications).toEqual(["wishOnEmpty"]);
  });

  it("drops the wish when the scan is cancelled, and keeps the reason for the page", async () => {
    const { fake, background } = await setup();
    await background.send("protectAfterScan", {});
    await background.send("cancelScan", {});
    await settle();
    expect(settingsOf(fake).protection).toBe(false);
    expect((await status(background)).wish).toMatchObject({ waiting: false, outcome: { kind: "cancelled" } });
    // Cancel was pressed on the page, which says what follows: no notification.
    expect(fake.notifications).toEqual([]);
    expect(fake.badge.title).toBe("tooltip_off");
  });

  it("drops the wish when the scan could not read a folder, and says so also when nobody looks", async () => {
    const { fake, background } = await setup();
    (fake.api.messages as unknown as { list: () => Promise<never> }).list = async () => {
      throw new Error("the server went away");
    };
    await background.send("protectAfterScan", {});
    await settle();
    expect(settingsOf(fake).protection).toBe(false);
    expect((await status(background)).wish).toMatchObject({ waiting: false, outcome: { kind: "errors" } });
    expect(fake.notifications).toEqual(["wishErrors"]);
    // A click on that notification leads to the switch.
    background.fire(fake.api.notifications.onClicked as unknown as FakeEvent, "protection-after-scan");
    await settle();
    expect(fake.optionsPageOpened).toBe(1);
  });

  it("sends no notification while the settings page is the tab in front", async () => {
    const { fake, background } = await setup();
    fake.optionsTab = { id: 7, windowId: 1 };
    fake.optionsTabActive = true;
    await background.send("protectAfterScan", {});
    await settle();
    expect(settingsOf(fake).protection).toBe(true);
    expect(fake.notifications).toEqual([]);
  });

  it("lets the user call the wish off, and settles it when protection is switched by hand", async () => {
    const called = await setup();
    await called.background.send("protectAfterScan", {});
    await called.background.send("clearProtectionWish", {});
    await settle();
    expect(settingsOf(called.fake).protection).toBe(false);
    expect(called.fake.storage[KEY_PROTECTION_WISH]).toBeUndefined();
    expect((await status(called.background)).wish).toEqual(NOTHING_WAITS);

    // "Switch on anyway" while the wish waits: protection is on now, and the scan that ends later changes nothing.
    const byHand = await setup();
    await byHand.background.send("protectAfterScan", {});
    await byHand.background.send("setProtection", { on: true });
    const onAt = settingsOf(byHand.fake).protectionOnAt;
    await settle();
    expect(settingsOf(byHand.fake).protection).toBe(true);
    expect(settingsOf(byHand.fake).protectionOnAt).toBe(onAt);
    expect((await status(byHand.background)).wish).toEqual(NOTHING_WAITS);
    expect(byHand.fake.notifications).toEqual([]);
  });

  it("forgets what the last wish came to when protection is switched or the next scan starts", async () => {
    const outcome = { kind: "cancelled", at: 5, scanned: 2 };
    const scanned = await setup({ [KEY_PROTECTION_WISH]: { waiting: null, outcome } });
    expect((await status(scanned.background)).wish.outcome).toEqual(outcome);
    await scanned.background.send("startScan", { from: null, to: null });
    expect((await status(scanned.background)).wish.outcome).toBeNull();

    const switched = await setup({ [KEY_PROTECTION_WISH]: { waiting: null, outcome } });
    await switched.background.send("setProtection", { on: true });
    expect(switched.fake.storage[KEY_PROTECTION_WISH]).toBeUndefined();
  });

  it("keeps the wish across a restart of Thunderbird: the scan starts again and protection follows it", async () => {
    const { fake, background } = await setup({ [KEY_PROTECTION_WISH]: { waiting: { since: 5, from: null, to: null }, outcome: null } });
    // The background page was loaded with the stored wish and no scan: it started one by itself.
    const after = await status(background);
    expect(after.scan).toMatchObject({ running: false, scanned: 3 });
    expect(after.wish).toMatchObject({ waiting: false, outcome: { kind: "on" } });
    expect(settingsOf(fake).protection).toBe(true);
  });

  it("does nothing when protection is on already, and ignores a stored wish that is not one", async () => {
    const on = await setup({ [KEY_SETTINGS]: { ...defaultSettings(Date.now()), protection: true, protectionOnAt: 1 } });
    await on.background.send("protectAfterScan", {});
    await settle();
    expect((await status(on.background)).scan).toBeNull();
    expect(on.fake.storage[KEY_PROTECTION_WISH]).toBeUndefined();

    const broken = await setup({ [KEY_PROTECTION_WISH]: { waiting: "yes" } });
    expect((await status(broken.background)).wish).toEqual(NOTHING_WAITS);
    expect((await status(broken.background)).scan).toBeNull();
    expect(settingsOf(broken.fake).protection).toBe(false);
  });
});

describe("an AI service that waits for the scan of the sent mail", () => {
  type Settings = ReturnType<typeof defaultSettings>;
  const sent = (id: number): tb.MessageHeader => ({ ...FakeBrowser.header(id, "Me <me@mycompany.example>", "f-sent"), recipients: [`person${id}@customer${id}.example`] });
  const on = (): Settings => ({ ...defaultSettings(Date.now()), protection: true, protectionOnAt: 1 });

  /** Protection is on, nobody was learned, and the service is saved switched off: the state in which "scan first" is asked. */
  async function setup(extra: Record<string, unknown> = {}, messages = 3, points: AccessPoint[] = [accessPoint({ id: "jev", name: "Jev", enabled: false })]) {
    const fake = new FakeBrowser({ [KEY_SETTINGS]: on(), [KEY_ACCESS_POINTS]: points, ...extra });
    fake.folderMessages.set(
      "f-sent",
      Array.from({ length: messages }, (_, index) => sent(index + 1)),
    );
    const background = await loadBackground(fake, fakeFetch({}).fetch);
    await settle();
    return { fake, background };
  }

  const status = async (background: Background) => {
    const reply = await background.send("getStatus", {});
    if (!reply.ok) {
      throw new Error(reply.error);
    }
    return reply.result;
  };
  const enabled = (fake: FakeBrowser, id = "jev"): boolean => stored(fake).find((point) => point.id === id)?.enabled === true;

  it("scans first and then switches the service on by itself", async () => {
    const { fake, background } = await setup();
    expect(await background.send("enableAfterScan", { id: "jev" })).toEqual({ ok: true, result: null });
    // Stored at once, so the wish survives a closed settings page and a restart.
    expect(fake.storage[KEY_PROTECTION_WISH]).toMatchObject({ services: { ids: ["jev"], from: null, to: null } });
    expect((await status(background)).wish).toMatchObject({ waiting: false, services: ["jev"] });
    expect(enabled(fake)).toBe(false);

    await settle();
    const after = await status(background);
    expect(after.scan).toMatchObject({ running: false, scanned: 3 });
    expect(after.wish).toMatchObject({ services: [], servicesOutcome: { kind: "on", scanned: 3, ids: ["jev"] } });
    expect(enabled(fake)).toBe(true);
    // The settings page is not in front: one notification says what happened.
    expect(fake.notifications).toEqual(["servicesWishOn(Jev)"]);
  });

  it("waits for a scan that is already running, with its dates, instead of starting a second one", async () => {
    const { fake, background } = await setup();
    const from = Date.UTC(2020, 0, 1);
    await background.send("startScan", { from, to: null });
    await background.send("enableAfterScan", { id: "jev" });
    expect(fake.storage[KEY_PROTECTION_WISH]).toMatchObject({ services: { ids: ["jev"], from, to: null } });
    await settle();
    expect(enabled(fake)).toBe(true);
  });

  it("lets a second service wait with the first, and names both in one notification", async () => {
    const { fake, background } = await setup({}, 3, [accessPoint({ id: "jev", name: "Jev", enabled: false }), accessPoint({ id: "openai", name: "OpenAI", enabled: false })]);
    await background.send("enableAfterScan", { id: "jev" });
    await background.send("enableAfterScan", { id: "openai" });
    expect((await status(background)).wish.services).toEqual(["jev", "openai"]);
    await settle();
    expect(enabled(fake, "jev")).toBe(true);
    expect(enabled(fake, "openai")).toBe(true);
    expect(fake.notifications).toEqual(["servicesWishOnMany(Jev, OpenAI)"]);
  });

  it("switches the service on after a scan that read no message, and says that it found none", async () => {
    const { fake, background } = await setup({}, 0);
    await background.send("enableAfterScan", { id: "jev" });
    await settle();
    expect(enabled(fake)).toBe(true);
    expect(fake.notifications).toEqual(["servicesWishOnEmpty(Jev)"]);
  });

  it("drops the wish when the scan is cancelled or fails: the service stays off and the reason is kept for its row", async () => {
    const cancelled = await setup();
    await cancelled.background.send("enableAfterScan", { id: "jev" });
    await cancelled.background.send("cancelScan", {});
    await settle();
    expect(enabled(cancelled.fake)).toBe(false);
    expect((await status(cancelled.background)).wish).toMatchObject({ services: [], servicesOutcome: { kind: "cancelled", ids: ["jev"] } });
    // Cancel was pressed on the page, which says what follows: no notification.
    expect(cancelled.fake.notifications).toEqual([]);

    const failed = await setup();
    (failed.fake.api.messages as unknown as { list: () => Promise<never> }).list = async () => {
      throw new Error("the server went away");
    };
    await failed.background.send("enableAfterScan", { id: "jev" });
    await settle();
    expect(enabled(failed.fake)).toBe(false);
    expect((await status(failed.background)).wish.servicesOutcome).toMatchObject({ kind: "errors", ids: ["jev"] });
    expect(failed.fake.notifications).toEqual(["servicesWishErrors(Jev)"]);
  });

  it("lets the user call the wish off, and settles it when the service is switched by hand", async () => {
    const called = await setup();
    await called.background.send("enableAfterScan", { id: "jev" });
    await called.background.send("clearServiceWish", { id: "jev" });
    await settle();
    expect(enabled(called.fake)).toBe(false);
    expect(called.fake.storage[KEY_PROTECTION_WISH]).toBeUndefined();
    expect((await status(called.background)).wish).toEqual(NOTHING_WAITS);

    // "Use it anyway" while the wish waits: the service is on now, and the scan that ends later says nothing about it.
    const byHand = await setup();
    await byHand.background.send("enableAfterScan", { id: "jev" });
    const jev = stored(byHand.fake)[0] as AccessPoint;
    await byHand.background.send("saveAccessPoint", { id: "jev", definition: { type: jev.type, name: jev.name, enabled: true, endpoint: jev.endpoint, model: jev.model }, apiKey: null });
    expect((await status(byHand.background)).wish.services).toEqual([]);
    await settle();
    expect(enabled(byHand.fake)).toBe(true);
    expect((await status(byHand.background)).wish).toEqual(NOTHING_WAITS);
    expect(byHand.fake.notifications).toEqual([]);
  });

  it("keeps the wish across a restart of Thunderbird: the scan starts again and the service follows it", async () => {
    const { fake, background } = await setup({ [KEY_PROTECTION_WISH]: { waiting: null, outcome: null, services: { since: 5, from: null, to: null, ids: ["jev"] }, servicesOutcome: null } });
    const after = await status(background);
    expect(after.scan).toMatchObject({ running: false, scanned: 3 });
    expect(after.wish).toMatchObject({ services: [], servicesOutcome: { kind: "on", ids: ["jev"] } });
    expect(enabled(fake)).toBe(true);
  });

  it("forgets a stored wish for a service that is gone, and what the last wish came to when the next scan starts", async () => {
    const gone = await setup({ [KEY_PROTECTION_WISH]: { waiting: null, outcome: null, services: { since: 5, from: null, to: null, ids: ["removed"] }, servicesOutcome: null } });
    expect((await status(gone.background)).wish).toEqual(NOTHING_WAITS);
    expect((await status(gone.background)).scan).toBeNull();

    const outcome = { kind: "cancelled", at: 5, scanned: 2, ids: ["jev"] };
    const scanned = await setup({ [KEY_PROTECTION_WISH]: { waiting: null, outcome: null, services: null, servicesOutcome: outcome } });
    expect((await status(scanned.background)).wish.servicesOutcome).toEqual(outcome);
    await scanned.background.send("startScan", { from: null, to: null });
    expect((await status(scanned.background)).wish.servicesOutcome).toBeNull();

    const seen = await setup({ [KEY_PROTECTION_WISH]: { waiting: null, outcome: null, services: null, servicesOutcome: outcome } });
    await seen.background.send("clearServiceWish", { id: null });
    expect(seen.fake.storage[KEY_PROTECTION_WISH]).toBeUndefined();
  });

  it("switches the service on at once when nothing is left to wait for", async () => {
    const learned = { list: "white", kind: "domain", value: "customer.example", scope: "all", source: "sent", addedAt: 5 };
    const { fake, background } = await setup({ [KEY_ENTRIES]: [learned] });
    await background.send("enableAfterScan", { id: "jev" });
    expect(enabled(fake)).toBe(true);
    expect((await status(background)).scan).toBeNull();
    expect((await status(background)).wish).toEqual(NOTHING_WAITS);
  });

  it("keeps services waiting when protection is switched, and takes a removed service off the wish", async () => {
    const { fake, background } = await setup({}, 3, [accessPoint({ id: "jev", name: "Jev", enabled: false }), accessPoint({ id: "openai", name: "OpenAI", enabled: false })]);
    // The scan is held back until the test lets it go on.
    const held = deferred<void>();
    const messages = fake.api.messages as unknown as { list: (...args: unknown[]) => Promise<unknown> };
    const list = messages.list.bind(messages);
    messages.list = async (...args) => {
      await held.promise;
      return list(...args);
    };
    await background.send("enableAfterScan", { id: "jev" });
    await background.send("enableAfterScan", { id: "openai" });
    await background.send("setProtection", { on: false });
    expect((await status(background)).wish.services).toEqual(["jev", "openai"]);
    await background.send("removeAccessPoint", { id: "openai" });
    expect((await status(background)).wish.services).toEqual(["jev"]);
    held.resolve();
    await settle();
    expect(enabled(fake, "jev")).toBe(true);
  });

  it("says in one notification what became of protection and of the service when both waited", async () => {
    const { fake, background } = await setup({ [KEY_SETTINGS]: defaultSettings(Date.now()) });
    await background.send("startScan", { from: null, to: null });
    await background.send("enableAfterScan", { id: "jev" });
    await background.send("protectAfterScan", {});
    await settle();
    expect((fake.storage[KEY_SETTINGS] as Settings).protection).toBe(true);
    expect(enabled(fake)).toBe(true);
    expect(fake.notifications).toEqual(["wishOn servicesAlsoOn(Jev)"]);
  });
});

describe("the choice to move mail without a verdict that waits for the scan of the sent mail", () => {
  type Settings = ReturnType<typeof defaultSettings>;
  const settingsOf = (fake: FakeBrowser): Settings => fake.storage[KEY_SETTINGS] as Settings;
  const sent = (id: number): tb.MessageHeader => ({ ...FakeBrowser.header(id, "Me <me@mycompany.example>", "f-sent"), recipients: [`person${id}@customer${id}.example`] });
  const on = (): Settings => ({ ...defaultSettings(Date.now()), protection: true, protectionOnAt: 1 });

  /** Protection is on, nobody was learned, no AI service, and mail without a verdict stays where it is: the state in which the choice asks "scan first". */
  async function setup(extra: Record<string, unknown> = {}, messages = 3) {
    const fake = new FakeBrowser({ [KEY_SETTINGS]: on(), ...extra });
    fake.folderMessages.set(
      "f-sent",
      Array.from({ length: messages }, (_, index) => sent(index + 1)),
    );
    const background = await loadBackground(fake, fakeFetch({}).fetch);
    await settle();
    return { fake, background };
  }

  const status = async (background: Background) => {
    const reply = await background.send("getStatus", {});
    if (!reply.ok) {
      throw new Error(reply.error);
    }
    return reply.result;
  };

  it("counts mail that is moved before anyone was learned as a problem on the toolbar button, with no AI service at all", async () => {
    const { fake, background } = await setup({ [KEY_SETTINGS]: { ...on(), noVerdictAction: "junk" } });
    expect(fake.badge).toMatchObject({ text: "!", title: "badgeProblems_one(1, cause_before_scan)" });
    // The scan ends the problem: everyone the sent mail names is on the white list.
    await background.send("startScan", { from: null, to: null });
    await settle();
    expect(fake.badge).toMatchObject({ text: "", title: "tooltip_on" });
  });

  it("keeps the stored setting until the scan has ended, then makes the choice by itself and says so", async () => {
    const { fake, background } = await setup();
    expect(await background.send("noVerdictAfterScan", { action: "junk" })).toEqual({ ok: true, result: null });
    // Stored at once, so the choice survives a closed settings page and a restart. Nothing is moved meanwhile.
    expect(fake.storage[KEY_PROTECTION_WISH]).toMatchObject({ noVerdict: { action: "junk", from: null, to: null }, noVerdictOutcome: null });
    expect((await status(background)).wish).toMatchObject({ noVerdict: "junk", noVerdictOutcome: null });
    expect(settingsOf(fake).noVerdictAction).toBe("leave");
    expect(fake.badge.title).toBe("tooltip_on");

    await settle();
    const after = await status(background);
    expect(after.scan).toMatchObject({ running: false, scanned: 3 });
    expect(after.wish).toMatchObject({ noVerdict: null, noVerdictOutcome: { kind: "on", scanned: 3, action: "junk" } });
    expect(settingsOf(fake).noVerdictAction).toBe("junk");
    // The settings page is not in front: a notification says what happened. No problem is left: the contacts are learned.
    expect(fake.notifications).toEqual(["noVerdictWishOn(whereJunk)"]);
    expect(fake.badge).toMatchObject({ text: "", title: "tooltip_on" });
  });

  it("waits for a scan that is already running, with its dates, and says when it found no sent mail", async () => {
    const running = await setup();
    const from = Date.UTC(2020, 0, 1);
    await running.background.send("startScan", { from, to: null });
    await running.background.send("noVerdictAfterScan", { action: "screening" });
    expect(running.fake.storage[KEY_PROTECTION_WISH]).toMatchObject({ noVerdict: { action: "screening", from, to: null } });
    await settle();
    expect(settingsOf(running.fake).noVerdictAction).toBe("screening");

    const empty = await setup({}, 0);
    await empty.background.send("noVerdictAfterScan", { action: "screening" });
    await settle();
    expect(settingsOf(empty.fake).noVerdictAction).toBe("screening");
    expect(empty.fake.notifications).toEqual(["noVerdictWishOnEmpty(whereScreening)"]);
  });

  it("drops the choice when the scan is cancelled or fails: the setting stays what it was and the reason is kept for the page", async () => {
    const cancelled = await setup();
    await cancelled.background.send("noVerdictAfterScan", { action: "junk" });
    await cancelled.background.send("cancelScan", {});
    await settle();
    expect(settingsOf(cancelled.fake).noVerdictAction).toBe("leave");
    expect((await status(cancelled.background)).wish).toMatchObject({ noVerdict: null, noVerdictOutcome: { kind: "cancelled", action: "junk" } });
    // Cancel was pressed on the page, which says what follows: no notification.
    expect(cancelled.fake.notifications).toEqual([]);

    const failed = await setup();
    (failed.fake.api.messages as unknown as { list: () => Promise<never> }).list = async () => {
      throw new Error("the server went away");
    };
    await failed.background.send("noVerdictAfterScan", { action: "junk" });
    await settle();
    expect(settingsOf(failed.fake).noVerdictAction).toBe("leave");
    expect((await status(failed.background)).wish.noVerdictOutcome).toMatchObject({ kind: "errors", action: "junk" });
    expect(failed.fake.notifications).toEqual(["noVerdictWishErrors"]);
    // The next scan makes what the last choice came to history.
    await failed.background.send("startScan", { from: null, to: null });
    expect((await status(failed.background)).wish.noVerdictOutcome).toBeNull();
  });

  it("lets the user call the choice off, and settles it when the menu is changed by hand", async () => {
    const called = await setup();
    await called.background.send("noVerdictAfterScan", { action: "junk" });
    await called.background.send("clearNoVerdictWish", {});
    await settle();
    expect(settingsOf(called.fake).noVerdictAction).toBe("leave");
    expect(called.fake.storage[KEY_PROTECTION_WISH]).toBeUndefined();
    expect((await status(called.background)).wish).toEqual(NOTHING_WAITS);

    // "Choose anyway", or another choice, while the first one waits: the menu's value is stored now, and the scan that ends later changes nothing.
    const byHand = await setup();
    await byHand.background.send("noVerdictAfterScan", { action: "junk" });
    await byHand.background.send("updateSettings", { patch: { noVerdictAction: "screening" } });
    expect((await status(byHand.background)).wish.noVerdict).toBeNull();
    await settle();
    expect(settingsOf(byHand.fake).noVerdictAction).toBe("screening");
    expect((await status(byHand.background)).wish).toEqual(NOTHING_WAITS);
    expect(byHand.fake.notifications).toEqual([]);

    // Another setting that is changed meanwhile leaves the choice waiting.
    const other = await setup();
    await other.background.send("noVerdictAfterScan", { action: "junk" });
    await other.background.send("updateSettings", { patch: { observation: true } });
    expect((await status(other.background)).wish.noVerdict).toBe("junk");
    await settle();
    expect(settingsOf(other.fake).noVerdictAction).toBe("junk");
  });

  it("keeps the choice across a restart of Thunderbird: the scan starts again and the choice follows it", async () => {
    const { fake, background } = await setup({ [KEY_PROTECTION_WISH]: { noVerdict: { since: 5, from: null, to: null, action: "junk" } } });
    const after = await status(background);
    expect(after.scan).toMatchObject({ running: false, scanned: 3 });
    expect(after.wish).toMatchObject({ noVerdict: null, noVerdictOutcome: { kind: "on", action: "junk" } });
    expect(settingsOf(fake).noVerdictAction).toBe("junk");

    // A stored choice that was made some other way since has nothing left to wait for, and one that is not a choice is ignored.
    const made = await setup({ [KEY_SETTINGS]: { ...on(), noVerdictAction: "junk" }, [KEY_PROTECTION_WISH]: { noVerdict: { since: 5, from: null, to: null, action: "junk" } } });
    expect((await status(made.background)).scan).toBeNull();
    expect(made.fake.storage[KEY_PROTECTION_WISH]).toBeUndefined();
    const broken = await setup({ [KEY_PROTECTION_WISH]: { noVerdict: { since: 5, from: null, to: null, action: "leave" } } });
    expect((await status(broken.background)).wish).toEqual(NOTHING_WAITS);
    expect((await status(broken.background)).scan).toBeNull();
  });

  it("makes the choice at once when nothing is left to wait for, and refuses a choice that moves nothing", async () => {
    const learned = { list: "white", kind: "domain", value: "customer.example", scope: "all", source: "sent", addedAt: 5 };
    const { fake, background } = await setup({ [KEY_ENTRIES]: [learned] });
    await background.send("noVerdictAfterScan", { action: "junk" });
    expect(settingsOf(fake).noVerdictAction).toBe("junk");
    expect((await status(background)).scan).toBeNull();
    expect(fake.storage[KEY_PROTECTION_WISH]).toBeUndefined();
    expect((await background.send("noVerdictAfterScan", { action: "leave" as "junk" })).ok).toBe(false);
  });

  it("says in one notification what became of protection, of the service and of the choice when all three waited", async () => {
    const jev = accessPoint({ id: "jev", name: "Jev", enabled: false });
    const { fake, background } = await setup({ [KEY_SETTINGS]: defaultSettings(Date.now()), [KEY_ACCESS_POINTS]: [jev] });
    await background.send("startScan", { from: null, to: null });
    await background.send("enableAfterScan", { id: "jev" });
    await background.send("noVerdictAfterScan", { action: "junk" });
    await background.send("protectAfterScan", {});
    await settle();
    expect(settingsOf(fake)).toMatchObject({ protection: true, noVerdictAction: "junk" });
    expect(fake.notifications).toEqual(["wishOn servicesAlsoOn(Jev) noVerdictAlsoOn(whereJunk)"]);

    // Protection and the choice without a service: the scan is announced once.
    const two = await setup({ [KEY_SETTINGS]: defaultSettings(Date.now()) });
    (two.fake.api.messages as unknown as { list: () => Promise<never> }).list = async () => {
      throw new Error("the server went away");
    };
    await two.background.send("noVerdictAfterScan", { action: "junk" });
    await two.background.send("protectAfterScan", {});
    await settle();
    expect(settingsOf(two.fake)).toMatchObject({ protection: false, noVerdictAction: "leave" });
    expect(two.fake.notifications).toEqual(["wishErrors noVerdictAlsoNotOn"]);
  });
});

describe("import while protection is on and the sent mail was not scanned", () => {
  it("imports AI services switched off and says how many, so that none gets mail from people the user writes to unasked", async () => {
    const fake = new FakeBrowser({ [KEY_SETTINGS]: { ...defaultSettings(Date.now()), protection: true, protectionOnAt: 1 } });
    const background = await loadBackground(fake, fakeFetch({}).fetch);
    const exported = await background.send("exportData", {});
    if (!exported.ok) {
      throw new Error(exported.error);
    }
    const file = { ...(exported.result.file as unknown as Record<string, unknown>), accessPoints: [{ type: "systemone", name: "Local", enabled: true, endpoint: "http://127.0.0.1:8765/v1/decisions", model: "" }] };
    const reply = await background.send("importData", { file, mode: "replace" });
    expect(reply).toMatchObject({ ok: true, result: { mode: "replace", accessPoints: 1, servicesOff: 1, noVerdictKept: false, undoId: null } });
    expect(stored(fake)).toMatchObject([{ name: "Local", enabled: false }]);
  });

  it("does not take over a choice that would start moving mail without a verdict, and says so", async () => {
    type Settings = ReturnType<typeof defaultSettings>;
    const on = { ...defaultSettings(Date.now()), protection: true, protectionOnAt: 1 };
    const exportOf = async (background: Background): Promise<Record<string, unknown>> => {
      const exported = await background.send("exportData", {});
      if (!exported.ok) {
        throw new Error(exported.error);
      }
      return exported.result.file as unknown as Record<string, unknown>;
    };
    const moving = (file: Record<string, unknown>): Record<string, unknown> => ({ ...file, settings: { ...(file.settings as Record<string, unknown>), noVerdictAction: "junk" } });

    const fake = new FakeBrowser({ [KEY_SETTINGS]: on });
    const background = await loadBackground(fake, fakeFetch({}).fetch);
    const reply = await background.send("importData", { file: moving(await exportOf(background)), mode: "replace" });
    expect(reply).toMatchObject({ ok: true, result: { mode: "replace", noVerdictKept: true } });
    expect((fake.storage[KEY_SETTINGS] as Settings).noVerdictAction).toBe("leave");

    // A choice that moves mail already is the user's own: the file may change the folder.
    const already = new FakeBrowser({ [KEY_SETTINGS]: { ...on, noVerdictAction: "screening" } });
    const second = await loadBackground(already, fakeFetch({}).fetch);
    expect(await second.send("importData", { file: moving(await exportOf(second)), mode: "replace" })).toMatchObject({ ok: true, result: { noVerdictKept: false } });
    expect((already.storage[KEY_SETTINGS] as Settings).noVerdictAction).toBe("junk");

    // While protection is off the choice is taken over: the question comes when protection is switched on.
    const off = new FakeBrowser({ [KEY_SETTINGS]: defaultSettings(Date.now()) });
    const third = await loadBackground(off, fakeFetch({}).fetch);
    expect(await third.send("importData", { file: moving(await exportOf(third)), mode: "replace" })).toMatchObject({ ok: true, result: { noVerdictKept: false } });
    expect((off.storage[KEY_SETTINGS] as Settings).noVerdictAction).toBe("junk");
  });
});

describe("undoing a merge of an import", () => {
  const white = (value: string, addedAt = 5) => ({ list: "white", kind: "domain", value, scope: "all", source: "manual", addedAt });
  const black = (value: string, addedAt = 5) => ({ list: "black", kind: "domain", value, scope: "all", source: "manual", addedAt });

  async function setup(entries: unknown[]) {
    const fake = new FakeBrowser({ [KEY_SETTINGS]: defaultSettings(Date.now()), [KEY_ENTRIES]: entries });
    const background = await loadBackground(fake, fakeFetch({}).fetch);
    const exported = await background.send("exportData", {});
    if (!exported.ok) {
      throw new Error(exported.error);
    }
    return { fake, background, file: exported.result.file as unknown as Record<string, unknown> };
  }

  it("removes what the merge added and puts back what it moved, exactly, also with thousands of entries", async () => {
    const mine = [black("blocked-here.example", 7), white("kept.example", 8)];
    const { fake, background, file } = await setup(mine);
    const many = Array.from({ length: 3000 }, (_, index) => ({ list: "white", kind: "domain", value: `new${index}.example`, scope: "all", source: "scan", addedAt: 9 }));
    const incoming = { ...file, entries: [{ list: "white", kind: "domain", value: "blocked-here.example", scope: "all", source: "sent", addedAt: 9 }, { list: "white", kind: "domain", value: "kept.example", scope: "all", source: "sent", addedAt: 9 }, ...many] };
    const reply = await background.send("importData", { file: incoming, mode: "merge" });
    expect(reply).toMatchObject({ ok: true, result: { entriesAdded: 3000, entriesReplaced: 1, entriesUnchanged: 1, movedToWhite: ["blocked-here.example"], movedToBlack: [] } });
    if (!reply.ok || reply.result.undoId === null) {
      throw new Error("the merge offered no Undo");
    }
    // The page gets a name for the Undo, not the thousands of entries it covers.
    expect(reply.result).not.toHaveProperty("undo");
    expect((fake.storage[KEY_ENTRIES] as unknown[]).length).toBe(3002);

    expect(await background.send("undoImport", { id: reply.result.undoId })).toEqual({ ok: true, result: { removed: 3000, restored: 1 } });
    expect(fake.storage[KEY_ENTRIES]).toEqual(mine);
    // It can be taken back once.
    expect(await background.send("undoImport", { id: reply.result.undoId })).toMatchObject({ ok: false, code: "undo-gone" });
  });

  it("offers no Undo for a merge that changed nothing, and forgets the last one when asked or when the next import comes", async () => {
    const { fake, background, file } = await setup([white("kept.example")]);
    expect(await background.send("importData", { file, mode: "merge" })).toMatchObject({ ok: true, result: { entriesAdded: 0, entriesReplaced: 0, undoId: null } });

    const added = await background.send("importData", { file: { ...file, entries: [{ list: "white", kind: "domain", value: "more.example", scope: "all", source: "sent", addedAt: 9 }] }, mode: "merge" });
    if (!added.ok || added.result.undoId === null) {
      throw new Error("the merge offered no Undo");
    }
    await background.send("forgetImport", {});
    expect(await background.send("undoImport", { id: added.result.undoId })).toMatchObject({ ok: false, code: "undo-gone" });
    expect((fake.storage[KEY_ENTRIES] as unknown[]).length).toBe(2);
  });
});

describe("showing the message of a log entry", () => {
  it("opens the message in a tab by its Message-ID, and says when it is gone", async () => {
    const fake = new FakeBrowser({ [KEY_SETTINGS]: defaultSettings(Date.now()) });
    fake.folderMessages.set("f-junk", [FakeBrowser.header(7, "Growth <growth@leadgen.example>", "f-junk")]);
    const background = await loadBackground(fake, fakeFetch({}).fetch);
    expect(await background.send("showMessage", { accountId: "account1", messageId: "msg-7@test" })).toEqual({ ok: true, result: { found: true } });
    expect(fake.openedMessages).toEqual([7]);
    expect(await background.send("showMessage", { accountId: "account1", messageId: "gone@test" })).toEqual({ ok: true, result: { found: false } });
    expect(await background.send("showMessage", { accountId: "account1", messageId: "" })).toEqual({ ok: true, result: { found: false } });
    expect(fake.openedMessages).toEqual([7]);
  });
});

describe("stored data that is not valid", () => {
  it("names the one setting that is wrong and sets only that one back, when the user asks", async () => {
    const entries = [{ list: "black", kind: "domain", value: "outreach.example", scope: "all", source: "manual", addedAt: 5 }];
    const settings = { ...defaultSettings(Date.now()), cutoff: 7, forwardingMailboxes: ["office@partner.example"] };
    const fake = new FakeBrowser({ [KEY_SETTINGS]: settings, [KEY_ENTRIES]: entries });
    const background = await loadBackground(fake, fakeFetch({}).fetch);
    expect(await background.send("getStatus", {})).toMatchObject({ ok: true, result: { repair: ["cutoff"] } });
    // Nothing is repaired by itself.
    expect((fake.storage[KEY_SETTINGS] as { cutoff: number }).cutoff).toBe(7);
    // Only a setting that was named can be set back.
    expect(await background.send("repairSetting", { name: "prompt" })).toMatchObject({ ok: false });
    expect(await background.send("repairSetting", { name: "entries" })).toMatchObject({ ok: false });

    expect(await background.send("repairSetting", { name: "cutoff" })).toEqual({ ok: true, result: null });
    expect(fake.storage[KEY_SETTINGS]).toEqual({ ...settings, cutoff: 0.85 });
    expect(fake.storage[KEY_ENTRIES]).toEqual(entries);
    expect(await background.send("getStatus", {})).toMatchObject({ ok: true, result: { fatal: null, repair: null } });
    expect(await background.send("repairSetting", { name: "cutoff" })).toMatchObject({ ok: false });
  });

  it("offers no single repair when something other than a setting is wrong", async () => {
    const settings = { ...defaultSettings(Date.now()), cutoff: 7 };
    const fake = new FakeBrowser({ [KEY_SETTINGS]: settings, [KEY_ENTRIES]: [{ list: "grey" }] });
    const background = await loadBackground(fake, fakeFetch({}).fetch);
    const status = await background.send("getStatus", {});
    expect(status).toMatchObject({ ok: true, result: { repair: null } });
    expect(status.ok && status.result.fatal).not.toBeNull();
    expect(await background.send("repairSetting", { name: "cutoff" })).toMatchObject({ ok: false });
    expect((fake.storage[KEY_SETTINGS] as { cutoff: number }).cutoff).toBe(7);
  });
});

describe("folders that cannot be right in a list", () => {
  const folder = (path: string) => ({ accountId: "account1", path });

  async function setup(settings: Record<string, unknown> = {}) {
    const fake = new FakeBrowser({ [KEY_SETTINGS]: { ...defaultSettings(Date.now()), ...settings } });
    const background = await loadBackground(fake, fakeFetch({}).fetch);
    await settle();
    const saved = (): ReturnType<typeof defaultSettings> => fake.storage[KEY_SETTINGS] as ReturnType<typeof defaultSettings>;
    return { fake, background, saved };
  }

  it("refuses the Inbox as a Sent folder, Sent as a monitored folder and Junk as the screening folder, with a code", async () => {
    const { background, saved } = await setup();
    expect(await background.send("updateSettings", { patch: { sentFoldersAdded: [folder("/INBOX")] } })).toMatchObject({ ok: false, code: "folder-role" });
    expect(await background.send("updateSettings", { patch: { monitoredFoldersAdded: [folder("/Sent")] } })).toMatchObject({ ok: false, code: "folder-role" });
    expect(await background.send("updateSettings", { patch: { screeningFolders: [folder("/Junk")] } })).toMatchObject({ ok: false, code: "folder-role" });
    expect(saved()).toMatchObject({ sentFoldersAdded: [], monitoredFoldersAdded: [], screeningFolders: [] });
  });

  it("gives a folder one job: the screening folder cannot be monitored as well", async () => {
    const { background, saved } = await setup();
    expect(await background.send("updateSettings", { patch: { screeningFolders: [folder("/Screening")] } })).toMatchObject({ ok: true });
    expect(await background.send("updateSettings", { patch: { monitoredFoldersAdded: [folder("/Screening")] } })).toMatchObject({ ok: false, code: "folder-role" });
    expect(saved()).toMatchObject({ monitoredFoldersAdded: [], screeningFolders: [folder("/Screening")] });
  });

  it("leaves a folder that is stored on its list, lets other settings change, and lets it be removed", async () => {
    const { background, saved } = await setup({ sentFoldersAdded: [folder("/INBOX")] });
    expect(await background.send("updateSettings", { patch: { observation: true } })).toMatchObject({ ok: true });
    expect(await background.send("updateSettings", { patch: { sentFoldersAdded: [folder("/INBOX"), folder("/Screening")] } })).toMatchObject({ ok: true });
    expect(saved().sentFoldersAdded).toEqual([folder("/INBOX"), folder("/Screening")]);
    expect(await background.send("updateSettings", { patch: { sentFoldersAdded: [folder("/Screening")] } })).toMatchObject({ ok: true });
    // Once removed, it is not taken back.
    expect(await background.send("updateSettings", { patch: { sentFoldersAdded: [folder("/Screening"), folder("/INBOX")] } })).toMatchObject({ ok: false, code: "folder-role" });
  });

  it("makes an existing folder of that name the screening folder, unless it has another job", async () => {
    // The fake answers a message key with the key itself, so that is the name of the folder.
    const name = "/screeningFolderName";
    const free = await setup();
    free.fake.extraFolders.push(FakeBrowser.folder(name));
    expect(await free.background.send("createScreeningFolder", { accountId: "account1" })).toEqual({ ok: true, result: { path: name } });
    expect(free.saved().screeningFolders).toEqual([folder(name)]);

    const monitored = await setup({ monitoredFoldersAdded: [folder(name)] });
    monitored.fake.extraFolders.push(FakeBrowser.folder(name));
    expect(await monitored.background.send("createScreeningFolder", { accountId: "account1" })).toMatchObject({ ok: false, code: "folder-role" });
    expect(monitored.saved().screeningFolders).toEqual([]);

    // Inside the Inbox, where some servers put it.
    const nested = await setup();
    nested.fake.extraFolders.push(FakeBrowser.folder(`/INBOX${name}`));
    expect(await nested.background.send("createScreeningFolder", { accountId: "account1" })).toEqual({ ok: true, result: { path: `/INBOX${name}` } });
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
      result: { list: "white", change: "move", target: { kind: "domain", value: "leadgen.example" }, scope: "all", move: "moved" },
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
    expect(await background.send("logAction", { entry: spam, action: "trust" })).toMatchObject({ ok: true, result: { change: "move", move: "not-found" } });
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

  it("lets a new service wait for the scan while protection is on and nobody was learned, unless the user said to use it anyway", async () => {
    const protectedSetup = async () => {
      const fake = new FakeBrowser({ [KEY_SETTINGS]: { ...defaultSettings(Date.now()), protection: true, protectionOnAt: 1 } });
      for (const origin of CHATGPT_ORIGINS) {
        fake.granted.add(origin);
      }
      // The scan of the sent mail is held back until the test lets it go on.
      const held = deferred<void>();
      const messages = fake.api.messages as unknown as { list: (...args: unknown[]) => Promise<unknown> };
      const list = messages.list.bind(messages);
      messages.list = async (...args) => {
        await held.promise;
        return list(...args);
      };
      const openai = await fakeOpenAi();
      const background = await loadBackground(fake, openai.http.fetch);
      return { fake, openai, background, held };
    };
    const finish = async (run: Awaited<ReturnType<typeof protectedSetup>>, afterScan: boolean | null) => {
      const callback = await startSignIn(run.background, run.openai.session, afterScan);
      const finishing = run.background.send("finishSignIn", { url: callback });
      await settle();
      run.openai.release();
      expect(await finishing).toEqual({ ok: true, result: null });
    };

    // "Scan first": the scan starts with the sign-in, the service arrives switched off and follows the scan.
    const first = await protectedSetup();
    await finish(first, true);
    expect(chatgptPoints(first.fake)[0]).toMatchObject({ enabled: false });
    expect(first.fake.storage[KEY_PROTECTION_WISH]).toMatchObject({ services: { ids: [chatgptPoints(first.fake)[0]?.id] } });
    first.held.resolve();
    await settle();
    expect(chatgptPoints(first.fake)[0]).toMatchObject({ enabled: true });

    // "Use it anyway": the service is on at once.
    const anyway = await protectedSetup();
    await finish(anyway, false);
    expect(chatgptPoints(anyway.fake)[0]).toMatchObject({ enabled: true });
    expect(anyway.fake.storage[KEY_PROTECTION_WISH]).toBeUndefined();

    // Not asked, because protection was switched on only after the sign-in had started: the safe answer is taken.
    const unasked = await protectedSetup();
    await finish(unasked, null);
    expect(chatgptPoints(unasked.fake)[0]).toMatchObject({ enabled: false });
    unasked.held.resolve();
    await settle();
    expect(chatgptPoints(unasked.fake)[0]).toMatchObject({ enabled: true });
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

  it("says in the status which service a sign-in in progress is for", async () => {
    const plan = accessPoint({ id: "plan", type: "chatgpt", endpoint: "https://api.openai.com/v1/responses", model: "gpt-6-luna", apiKey: "" });
    const fake = new FakeBrowser({ [KEY_SETTINGS]: defaultSettings(Date.now()), [KEY_ACCESS_POINTS]: [plan] });
    const openai = await fakeOpenAi();
    const background = await loadBackground(fake, openai.http.fetch);
    const signIn = async (): Promise<unknown> => {
      const status = await background.send("getStatus", {});
      return status.ok ? status.result.signIn : null;
    };
    expect(await signIn()).toMatchObject({ url: null, accessPointId: null });
    // A new service: the settings page shows the sign-in as a new row.
    expect(await background.send("startSignIn", { accessPointId: null, openTab: false })).toMatchObject({ ok: true });
    expect(await signIn()).toMatchObject({ accessPointId: null });
    expect(((await signIn()) as { url: string | null }).url).not.toBeNull();
    // Signing in again: the page shows it in the row of that service.
    expect(await background.send("startSignIn", { accessPointId: "plan", openTab: false })).toMatchObject({ ok: true });
    expect(await signIn()).toMatchObject({ accessPointId: "plan" });
    expect(await background.send("cancelSignIn", {})).toEqual({ ok: true, result: null });
    expect(await signIn()).toMatchObject({ url: null, accessPointId: null });
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
