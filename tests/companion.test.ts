// The companion add-on is plain privileged JavaScript without a module system. This
// test loads its Experiment in a sandbox with stand-ins for the Thunderbird globals
// and drives it with fake windows and key events.

import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/core/commands";
import { COMPANION_ID } from "../src/tb/protocol";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string): string => readFileSync(path.join(root, file), "utf8");

interface FakeNode {
  nodeType: number;
  localName?: string;
  isContentEditable?: boolean;
  isRemoteBrowser?: boolean;
  parentNode?: FakeNode | null;
  host?: FakeNode | null;
  designMode?: string;
  defaultView?: { frameElement: FakeNode | null } | null;
  ownerDocument?: unknown;
  getAttribute?: (name: string) => string | null;
}

function element(localName: string, extra: Partial<FakeNode> & { attributes?: Record<string, string> } = {}): FakeNode {
  const { attributes = {}, ...rest } = extra;
  return { nodeType: 1, localName, parentNode: null, getAttribute: (name) => attributes[name] ?? null, ...rest };
}

interface KeyEvent {
  type: string;
  key: string;
  isTrusted: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
  stopped: boolean;
  composedTarget: FakeNode;
  preventDefault(): void;
  stopPropagation(): void;
}

function keyEvent(key: string, partial: Partial<KeyEvent> = {}): KeyEvent {
  return {
    type: "keydown",
    key,
    isTrusted: true,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    repeat: false,
    defaultPrevented: false,
    stopped: false,
    composedTarget: element("tr"),
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
    ...partial,
  };
}

class FakeWindow {
  listeners = new Map<string, ((event: KeyEvent) => void)[]>();
  popups: { state: string }[] = [];
  document: {
    documentElement: { getAttribute(name: string): string | null };
    getElementById(id: string): unknown;
    querySelectorAll(selector: string): { state: string }[];
  };

  constructor(windowType: string, tabMode = "mail3PaneTab") {
    this.document = {
      documentElement: { getAttribute: (name) => (name === "windowtype" ? windowType : null) },
      getElementById: (id) => (id === "tabmail" ? { currentTabInfo: { mode: { name: tabMode } } } : null),
      querySelectorAll: () => this.popups,
    };
  }

  addEventListener(type: string, listener: (event: KeyEvent) => void, capture: boolean): void {
    expect(capture).toBe(true);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: (event: KeyEvent) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener));
  }

  press(event: KeyEvent): KeyEvent {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return event;
  }
}

function load() {
  const registered = new Map<string, { chromeURLs: string[]; onLoadWindow(window: FakeWindow): void; onUnloadWindow(window: FakeWindow): void }>();
  const observerNotes: string[] = [];
  const sandbox = {
    ChromeUtils: {
      importESModule(url: string) {
        expect(url).toBe("resource:///modules/ExtensionSupport.sys.mjs");
        return {
          ExtensionSupport: {
            registerWindowListener(id: string, listener: never) {
              registered.set(id, listener);
            },
            unregisterWindowListener(id: string) {
              registered.delete(id);
            },
          },
        };
      },
    },
    ExtensionCommon: {
      ExtensionAPI: class {
        extension: unknown;
        constructor(extension: unknown) {
          this.extension = extension;
        }
      },
      EventManager: class {
        options: { register(fire: { async(command: string): void }): () => void };
        constructor(options: never) {
          this.options = options;
        }
        api() {
          const options = this.options;
          const removers = new Map<unknown, () => void>();
          return {
            addListener(callback: (command: string) => void) {
              removers.set(callback, options.register({ async: callback }));
            },
            removeListener(callback: (command: string) => void) {
              removers.get(callback)?.();
              removers.delete(callback);
            },
          };
        }
      },
    },
    Services: { obs: { notifyObservers: (_subject: null, topic: string) => observerNotes.push(topic) } },
  };
  vm.runInNewContext(`${read("companion/api/implementation.js")}\nthis.bareKeys = bareKeys;`, sandbox);
  const Api = (sandbox as unknown as { bareKeys: new (extension: { id: string }) => { getAPI(context: object): { bareKeys: { onCommand: { addListener(callback: (command: string) => void): void; removeListener(callback: (command: string) => void): void } } }; onShutdown(isAppShutdown: boolean): void } }).bareKeys;
  const api = new Api({ id: COMPANION_ID });
  const commands: string[] = [];
  const listener = (command: string): void => {
    commands.push(command);
  };
  const event = api.getAPI({}).bareKeys.onCommand;
  event.addListener(listener);
  const windowListener = [...registered.values()][0];
  if (windowListener === undefined) {
    throw new Error("the window listener was not registered");
  }
  return { api, commands, listener, event, registered, windowListener, observerNotes };
}

describe("companion add-on", () => {
  it("is a separate add-on with an Experiment, pointing at the main add-on's id", () => {
    const manifest = JSON.parse(read("companion/manifest.json")) as Record<string, unknown>;
    const gecko = (manifest.browser_specific_settings as { gecko: Record<string, unknown> }).gecko;
    expect(gecko.id).toBe(COMPANION_ID);
    expect(gecko.strict_min_version).toBe("153.0");
    expect(Object.keys(manifest.experiment_apis as object)).toEqual(["bareKeys"]);
    expect(manifest.permissions).toBeUndefined();
    const mainManifest = JSON.parse(read("src/manifest.json")) as { browser_specific_settings: { gecko: { id: string } } };
    expect(read("companion/background.js")).toContain(`"${mainManifest.browser_specific_settings.gecko.id}"`);
    expect(read("companion/background.js")).toContain("runtime.sendMessage(MAIN_ADDON_ID, { command })");
  });

  it("watches the main window and message windows", () => {
    const { windowListener } = load();
    expect(windowListener.chromeURLs).toEqual([
      "chrome://messenger/content/messenger.xhtml",
      "chrome://messenger/content/messageWindow.xhtml",
    ]);
  });

  it("maps B, Shift+B, W and Shift+W to the four command names", () => {
    const { windowListener, commands } = load();
    const window = new FakeWindow("mail:3pane");
    windowListener.onLoadWindow(window);
    window.press(keyEvent("b"));
    window.press(keyEvent("B", { shiftKey: true }));
    window.press(keyEvent("w"));
    window.press(keyEvent("W", { shiftKey: true }));
    expect(commands).toEqual(["block-address", "block-domain", "trust-address", "trust-domain"]);
    expect(commands.every((command) => (COMMANDS as readonly string[]).includes(command))).toBe(true);
  });

  it("suppresses Thunderbird's own action for those keys, on keydown and keypress", () => {
    const { windowListener, commands } = load();
    const window = new FakeWindow("mail:3pane");
    windowListener.onLoadWindow(window);
    const down = window.press(keyEvent("b"));
    const press = window.press(keyEvent("b", { type: "keypress" }));
    expect(down.defaultPrevented && down.stopped).toBe(true);
    expect(press.defaultPrevented && press.stopped).toBe(true);
    expect(commands).toEqual(["block-address"]);
  });

  it("ignores other keys, modifiers, key repeat and composition", () => {
    const { windowListener, commands } = load();
    const window = new FakeWindow("mail:3pane");
    windowListener.onLoadWindow(window);
    for (const event of [
      keyEvent("a"),
      keyEvent("b", { ctrlKey: true }),
      keyEvent("b", { altKey: true }),
      keyEvent("w", { metaKey: true }),
      keyEvent("b", { isComposing: true }),
    ]) {
      expect(window.press(event).defaultPrevented).toBe(false);
    }
    const repeated = window.press(keyEvent("b", { repeat: true }));
    expect(repeated.defaultPrevented).toBe(true);
    expect(commands).toEqual([]);
  });

  it("ignores key events that a script dispatched", () => {
    const { windowListener, commands } = load();
    const window = new FakeWindow("mail:3pane");
    windowListener.onLoadWindow(window);
    for (const type of ["keydown", "keypress"]) {
      expect(window.press(keyEvent("b", { type, isTrusted: false })).defaultPrevented).toBe(false);
    }
    expect(commands).toEqual([]);
  });

  it("never captures keys in text fields", () => {
    const { windowListener, commands } = load();
    const window = new FakeWindow("mail:3pane");
    windowListener.onLoadWindow(window);
    const shadowInput = element("input", { parentNode: { nodeType: 11, host: element("search-bar") } as FakeNode });
    const remoteBrowser = element("browser", { isRemoteBrowser: true });
    const editorDocument: FakeNode = { nodeType: 9, designMode: "on", defaultView: { frameElement: null } };
    const insideFrame = element("p", { parentNode: { nodeType: 9, designMode: "off", defaultView: { frameElement: element("browser", { parentNode: element("div", { isContentEditable: true }) }) } } });
    for (const target of [
      element("input"),
      element("textarea"),
      element("select"),
      shadowInput,
      element("span", { parentNode: element("div", { isContentEditable: true }) }),
      element("div", { attributes: { role: "textbox" } }),
      remoteBrowser,
      element("body", { parentNode: editorDocument }),
      insideFrame,
    ]) {
      const event = window.press(keyEvent("b", { composedTarget: target }));
      expect(event.defaultPrevented, target.localName).toBe(false);
    }
    expect(commands).toEqual([]);
  });

  it("captures keys in the message list and in a displayed message", () => {
    const { windowListener, commands } = load();
    const window = new FakeWindow("mail:3pane");
    windowListener.onLoadWindow(window);
    const messageBody = element("p", { parentNode: { nodeType: 9, designMode: "off", defaultView: { frameElement: element("browser", { attributes: { type: "content" } }) } } });
    window.press(keyEvent("w", { composedTarget: messageBody }));
    expect(commands).toEqual(["trust-address"]);
  });

  it("acts only in mail tabs and message windows", () => {
    const { windowListener, commands } = load();
    const calendar = new FakeWindow("mail:3pane", "calendar");
    const content = new FakeWindow("mail:3pane", "contentTab");
    const messageTab = new FakeWindow("mail:3pane", "mailMessageTab");
    const messageWindow = new FakeWindow("mail:messageWindow", "");
    const compose = new FakeWindow("msgcompose", "");
    for (const window of [calendar, content, messageTab, messageWindow, compose]) {
      windowListener.onLoadWindow(window);
    }
    expect(calendar.press(keyEvent("b")).defaultPrevented).toBe(false);
    expect(content.press(keyEvent("b")).defaultPrevented).toBe(false);
    expect(compose.press(keyEvent("b")).defaultPrevented).toBe(false);
    expect(messageTab.press(keyEvent("b")).defaultPrevented).toBe(true);
    expect(messageWindow.press(keyEvent("w")).defaultPrevented).toBe(true);
    expect(commands).toEqual(["block-address", "trust-address"]);
  });

  it("leaves the keys to an open menu", () => {
    const { windowListener, commands } = load();
    const window = new FakeWindow("mail:3pane");
    windowListener.onLoadWindow(window);
    window.popups = [{ state: "closed" }, { state: "open" }];
    expect(window.press(keyEvent("b")).defaultPrevented).toBe(false);
    window.popups = [{ state: "closed" }];
    expect(window.press(keyEvent("b")).defaultPrevented).toBe(true);
    expect(commands).toEqual(["block-address"]);
  });

  it("removes its listeners when a window closes, when the listener is removed and on shutdown", () => {
    const { windowListener, commands, event, listener, registered, api, observerNotes } = load();
    const first = new FakeWindow("mail:3pane");
    const second = new FakeWindow("mail:3pane");
    windowListener.onLoadWindow(first);
    windowListener.onLoadWindow(second);
    windowListener.onUnloadWindow(first);
    expect(first.press(keyEvent("b")).defaultPrevented).toBe(false);

    event.removeListener(listener);
    expect(registered.size).toBe(0);
    expect(second.press(keyEvent("b")).defaultPrevented).toBe(false);
    expect(commands).toEqual([]);

    event.addListener(listener);
    expect(registered.size).toBe(1);
    api.onShutdown(false);
    expect(registered.size).toBe(0);
    expect(observerNotes).toEqual(["startupcache-invalidate"]);
    api.onShutdown(true);
    expect(observerNotes).toHaveLength(1);
  });
});
