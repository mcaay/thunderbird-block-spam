// The background page, loaded against a fake of the Thunderbird API and driven
// through the same requests the settings page and the popup send.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEY_ACCESS_POINTS, KEY_SETTINGS } from "../src/core/keys";
import { defaultSettings } from "../src/core/settings";
import type { AccessPoint } from "../src/core/types";
import { FakeBrowser, loadBackground } from "./helpers/browser";
import { accessPoint } from "./helpers/harness";
import { fakeFetch, jsonResponse } from "./helpers/http";

const COLLECTOR = "https://collector.example/v1";

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
