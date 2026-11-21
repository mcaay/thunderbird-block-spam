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
    expect(await background.send("selectedCount", { tabId: 1 })).toEqual({ ok: true, result: { count: 3, limit: 50 } });
    expect(await background.send("scoreSelected", { tabId: 1 })).toEqual({ ok: true, result: { selected: 3, scored: 3, failed: 0 } });
    expect(http.requests).toHaveLength(3);
  });

  it("refuses more than 50 messages before anything is sent", async () => {
    const { http, background } = await setup(5000);
    expect(await background.send("selectedCount", { tabId: 1 })).toEqual({ ok: true, result: { count: 51, limit: 50 } });
    expect(await background.send("scoreSelected", { tabId: 1 })).toEqual({ ok: false, error: "popupScoreTooMany(50)" });
    expect(http.requests).toHaveLength(0);
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
    await finishing;
    await settle();
    expect(chatgptPoints(fake)).toEqual([]);
    expect(openai.revoked()).toEqual(["refresh-new"]);
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
