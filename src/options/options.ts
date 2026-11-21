// The settings page. It never writes storage: it shows a snapshot and sends requests
// to the background, which is the only writer.

import { localizePage, t } from "../tb/i18n";
import { send } from "../tb/protocol";
import { toast } from "./dom";
import { loadModel } from "./model";
import type { Model } from "./model";
import type { Section } from "./section";
import { aiSection } from "./sections/ai";
import { forwardingSection, publicDomainsSection } from "./sections/domains";
import { incomingSection, learningSection } from "./sections/folders";
import { listsSection } from "./sections/lists";
import { dataSection, logSection, shortcutsSection } from "./sections/more";
import { statusSection } from "./sections/status";

const POLL_MS = 1000;
/** Storage changes arrive in bursts, for example during a scan. They are drawn at most this often. */
const REFRESH_DELAY_MS = 400;

let model: Model | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let refreshing: Promise<void> | null = null;

localizePage();
document.title = t("optionsTitle");

const sections: Section[] = [
  statusSection(),
  listsSection(),
  publicDomainsSection(),
  forwardingSection(),
  learningSection(startPolling),
  incomingSection(),
  aiSection(startPolling),
  shortcutsSection(),
  logSection(),
  dataSection(),
];

function renderAll(next: Model): void {
  model = next;
  document.body.classList.toggle("fatal-state", next.status.fatal !== null || next.settings === null);
  for (const section of sections) {
    try {
      section.render(next);
    } catch (error) {
      console.error("Block Spam: a settings section could not be drawn", error);
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
      toast(error instanceof Error ? error.message : String(error), "error");
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

void refresh();
