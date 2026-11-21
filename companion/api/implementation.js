// Experiment of the Block Spam Keys companion add-on.
//
// Captures B, Shift+B, W and Shift+W in mail windows (never in text fields),
// suppresses Thunderbird's own action for those keys and reports the matching
// command name. It contains nothing else: no mail access, no storage, no network.

/* global ChromeUtils, ExtensionCommon, Services */

"use strict";

var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");

const WINDOW_URLS = [
  "chrome://messenger/content/messenger.xhtml",
  "chrome://messenger/content/messageWindow.xhtml",
];
const MAIL_TAB_MODES = ["mail3PaneTab", "mailMessageTab"];
const TEXT_ELEMENTS = ["input", "textarea", "select", "search-textbox", "moz-input-box", "editor"];
const TEXT_ROLES = ["textbox", "searchbox", "combobox"];
const ELEMENT_NODE = 1;
const DOCUMENT_NODE = 9;

/** The command for a key event, or null when the key is not one of ours. */
function commandFor(event) {
  if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) {
    return null;
  }
  const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
  if (key === "b") {
    return event.shiftKey ? "block-domain" : "block-address";
  }
  if (key === "w") {
    return event.shiftKey ? "trust-domain" : "trust-address";
  }
  return null;
}

/**
 * True when typing belongs to the focused element: a text field, an editable
 * document, or web content shown in a remote browser. Walks from the event target
 * up through shadow trees and embedding frames.
 */
function isTextTarget(target) {
  let node = target;
  while (node) {
    if (node.nodeType === ELEMENT_NODE) {
      if (TEXT_ELEMENTS.includes(node.localName) || node.isContentEditable) {
        return true;
      }
      if (node.localName === "browser" && (node.isRemoteBrowser || node.getAttribute("remote") === "true")) {
        return true;
      }
      if (TEXT_ROLES.includes(node.getAttribute("role"))) {
        return true;
      }
    }
    if (node.nodeType === DOCUMENT_NODE) {
      if (node.designMode === "on") {
        return true;
      }
      node = node.defaultView ? node.defaultView.frameElement : null;
    } else {
      node = node.parentNode || node.host || null;
    }
  }
  return false;
}

/** True when the window shows mail: a mail tab, a message tab or a message window. */
function isMailContext(window) {
  const type = window.document.documentElement.getAttribute("windowtype");
  if (type === "mail:messageWindow") {
    return true;
  }
  if (type !== "mail:3pane") {
    return false;
  }
  const tabmail = window.document.getElementById("tabmail");
  const mode = tabmail && tabmail.currentTabInfo && tabmail.currentTabInfo.mode ? tabmail.currentTabInfo.mode.name : "";
  return MAIL_TAB_MODES.includes(mode);
}

/** True while a menu or panel is open: its keys belong to the menu. */
function hasOpenPopup(document) {
  for (const popup of document.querySelectorAll("menupopup, panel")) {
    if (popup.state === "open" || popup.state === "showing") {
      return true;
    }
  }
  return false;
}

var bareKeys = class extends ExtensionCommon.ExtensionAPI {
  constructor(extension) {
    super(extension);
    this.listeners = new Set();
    this.handlers = new Map();
    this.listenerId = `block-spam-keys:${extension.id}`;
    this.watching = false;
  }

  attach(window) {
    if (this.handlers.has(window)) {
      return;
    }
    const handler = (event) => {
      // Only real key presses: an event that a script dispatched is not trusted.
      if (!event.isTrusted) {
        return;
      }
      const command = commandFor(event);
      if (command === null || event.defaultPrevented) {
        return;
      }
      const target = event.composedTarget || event.originalTarget || event.target;
      if (!isMailContext(window) || isTextTarget(target)) {
        return;
      }
      if (hasOpenPopup(window.document) || (target && target.ownerDocument && hasOpenPopup(target.ownerDocument))) {
        return;
      }
      // Suppress Thunderbird's own action for the key (B: previous message, W: watch thread).
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "keydown" && !event.repeat) {
        for (const listener of this.listeners) {
          listener(command);
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    window.addEventListener("keypress", handler, true);
    this.handlers.set(window, handler);
  }

  detach(window) {
    const handler = this.handlers.get(window);
    if (handler) {
      window.removeEventListener("keydown", handler, true);
      window.removeEventListener("keypress", handler, true);
      this.handlers.delete(window);
    }
  }

  start() {
    if (this.watching) {
      return;
    }
    this.watching = true;
    ExtensionSupport.registerWindowListener(this.listenerId, {
      chromeURLs: WINDOW_URLS,
      onLoadWindow: (window) => this.attach(window),
      onUnloadWindow: (window) => this.detach(window),
    });
  }

  stop() {
    if (!this.watching) {
      return;
    }
    this.watching = false;
    ExtensionSupport.unregisterWindowListener(this.listenerId);
    for (const window of [...this.handlers.keys()]) {
      this.detach(window);
    }
  }

  getAPI(context) {
    const api = this;
    return {
      bareKeys: {
        onCommand: new ExtensionCommon.EventManager({
          context,
          name: "bareKeys.onCommand",
          register(fire) {
            const listener = (command) => {
              fire.async(command);
            };
            api.listeners.add(listener);
            api.start();
            return () => {
              api.listeners.delete(listener);
              if (api.listeners.size === 0) {
                api.stop();
              }
            };
          },
        }).api(),
      },
    };
  }

  onShutdown(isAppShutdown) {
    this.stop();
    if (!isAppShutdown) {
      // Lets an updated version of this script load without restarting Thunderbird.
      Services.obs.notifyObservers(null, "startupcache-invalidate");
    }
  }
};
