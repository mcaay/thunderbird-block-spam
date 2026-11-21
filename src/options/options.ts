// The settings page. It never writes storage: it shows a snapshot and sends requests
// to the background, which is the only writer.
//
// The page follows Thunderbird's own Settings: a category list on the left and one
// pane at a time on the right, chosen by the fragment of the address (#lists).

import { localizePage, t } from "../tb/i18n";
import { isPageEvent, send } from "../tb/protocol";
import type { SettingsTarget } from "../tb/protocol";
import { byId, errorText, toast } from "./dom";
import { loadModel } from "./model";
import type { Model } from "./model";
import { detectPermissionSupport } from "./permissions";
import { isPaneId, PANES } from "./section";
import type { Intent, PaneId, Section, Shell } from "./section";
import { advancedSection } from "./sections/advanced";
import { aiSection } from "./sections/ai";
import { backupSection } from "./sections/backup";
import { incomingSection } from "./sections/incoming";
import { learningSection } from "./sections/learning";
import { listsSection } from "./sections/lists";
import { logSection } from "./sections/log";
import { overviewSection } from "./sections/overview";
import { shortcutsSection } from "./sections/shortcuts";

const POLL_MS = 1000;
/** Storage changes arrive in bursts, for example during a scan. They are drawn at most this often. */
const REFRESH_DELAY_MS = 400;

let model: Model | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let refreshing: Promise<void> | null = null;
/** What the next change of pane should show there. */
let pendingIntent: Intent | null = null;
/** Set while the arrow keys walk the category list: the focus then stays in the list. */
let keepFocus = false;

localizePage();
document.title = t("optionsTitle");

const nav = byId("categories");
const links = new Map<PaneId, HTMLAnchorElement>();
for (const link of nav.querySelectorAll<HTMLAnchorElement>("a.category")) {
  const pane = link.hash.slice(1);
  if (isPaneId(pane)) {
    links.set(pane, link);
  }
}

function paneOfAddress(): PaneId {
  const pane = location.hash.slice(1);
  return isPaneId(pane) ? pane : "overview";
}

function isFatal(): boolean {
  return model !== null && (model.status.fatal !== null || model.settings === null);
}

/** Shows one pane and marks its category. While stored data is invalid only the Overview exists. */
function showPane(wanted: PaneId, focusTitle: boolean): PaneId {
  const pane = isFatal() ? "overview" : wanted;
  for (const id of PANES) {
    byId(id).hidden = id !== pane;
    const link = links.get(id);
    if (id === pane) {
      link?.setAttribute("aria-current", "page");
    } else {
      link?.removeAttribute("aria-current");
    }
  }
  if (focusTitle) {
    window.scrollTo(0, 0);
    byId(pane).querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
  }
  return pane;
}

const shell: Shell = {
  go(pane, intent) {
    pendingIntent = intent ?? null;
    if (paneOfAddress() === pane) {
      openPane();
    } else {
      location.hash = pane;
    }
  },
  startPolling,
  refresh,
};

const sections: Record<PaneId, Section> = {
  overview: overviewSection(shell),
  lists: listsSection(),
  log: logSection(),
  learning: learningSection(shell),
  incoming: incomingSection(shell),
  ai: aiSection(shell),
  shortcuts: shortcutsSection(shell),
  advanced: advancedSection(),
  backup: backupSection(),
};

/** Shows the pane the address names, moves the focus to its title and hands over the intent. */
function openPane(): void {
  const intent = pendingIntent;
  pendingIntent = null;
  const pane = showPane(paneOfAddress(), !keepFocus);
  keepFocus = false;
  if (intent !== null) {
    sections[pane].reveal?.(intent);
  }
}

window.addEventListener("hashchange", openPane);

// Up and Down walk the category list like the list of Thunderbird's Settings: the pane
// follows and the focus stays in the list. Tab and Enter work as for any link.
nav.addEventListener("keydown", (event) => {
  const current = event.target instanceof HTMLAnchorElement ? event.target : null;
  if (current === null || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return;
  }
  const visible = [...links.values()].filter((link) => link.offsetParent !== null);
  const index = visible.indexOf(current);
  const target =
    event.key === "ArrowDown" || event.key === "ArrowRight"
      ? visible[index + 1]
      : event.key === "ArrowUp" || event.key === "ArrowLeft"
        ? visible[index - 1]
        : event.key === "Home"
          ? visible[0]
          : event.key === "End"
            ? visible.at(-1)
            : undefined;
  if (index === -1 || target === undefined) {
    return;
  }
  event.preventDefault();
  target.focus();
  if (target.hash !== location.hash) {
    keepFocus = true;
    location.hash = target.hash;
  }
});

function renderAll(next: Model): void {
  const wasFatal = isFatal();
  model = next;
  document.body.classList.toggle("fatal-state", isFatal());
  if (isFatal() !== wasFatal) {
    showPane(paneOfAddress(), false);
  }
  for (const section of Object.values(sections)) {
    try {
      section.render(next);
    } catch (error) {
      console.error("Block Spam: a settings pane could not be drawn", error);
    }
  }
}

async function refresh(): Promise<void> {
  if (refreshing !== null) {
    await refreshing;
  }
  refreshing = (async () => {
    try {
      renderAll(await loadModel());
    } catch (error) {
      toast(errorText(error), { kind: "error" });
    }
  })();
  await refreshing;
  refreshing = null;
  if (needsPolling()) {
    startPolling();
  }
}

function scheduleRefresh(): void {
  if (refreshTimer !== null) {
    return;
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refresh();
  }, REFRESH_DELAY_MS);
}

function needsPolling(): boolean {
  const status = model?.status;
  return status !== undefined && (status.scan?.running === true || status.signIn.url !== null || status.scoring);
}

/** While a scan or a sign-in is in progress, asks the background for its state once a second. */
function startPolling(): void {
  if (pollTimer !== null) {
    return;
  }
  pollTimer = setInterval(() => {
    void (async () => {
      if (model === null) {
        return;
      }
      try {
        const status = await send("getStatus", {});
        const changed = JSON.stringify(status) !== JSON.stringify(model.status);
        if (changed) {
          renderAll({ ...model, status });
        }
        if (!needsPolling() && pollTimer !== null) {
          clearInterval(pollTimer);
          pollTimer = null;
          scheduleRefresh();
        }
      } catch {
        // The background page may be restarting. The next round tries again.
      }
    })();
  }, POLL_MS);
}

browser.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") {
    scheduleRefresh();
  }
});

// The popup asks for a pane, and in the log for one entry, to be shown: at once when
// this page is open, through the background when the page is only now being opened.
function showTarget(target: SettingsTarget): void {
  if (!isPaneId(target.pane)) {
    return;
  }
  shell.go(target.pane, target.pane === "log" && target.logKey !== null ? { kind: "log-entry", key: target.logKey } : undefined);
}

browser.runtime.onMessage.addListener((message) => {
  if (isPageEvent(message)) {
    showTarget(message.target);
    void send("takeSettingsTarget", {}).catch(() => undefined);
  }
  return undefined;
});

// Text that was typed but not saved is lost with the page: ask before leaving.
window.addEventListener("beforeunload", (event) => {
  if (Object.values(sections).some((section) => section.unsaved?.() === true)) {
    event.preventDefault();
  }
});

showPane(paneOfAddress(), false);
void detectPermissionSupport();
void (async () => {
  await refresh();
  try {
    const { target } = await send("takeSettingsTarget", {});
    if (target !== null) {
      showTarget(target);
    }
  } catch {
    // Stored data is invalid: only the Overview exists.
  }
})();
