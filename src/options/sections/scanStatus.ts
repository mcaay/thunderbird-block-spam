// The manual scan as the page shows it: a progress element while it runs, and what it
// did in words. The Overview and the Learning pane show the same scan.

import { scanIsComplete } from "../../core/problems";
import { t } from "../../tb/i18n";
import { diagnosticText } from "../diagnostic";
import { h } from "../dom";
import { folderView } from "../model";
import type { Model } from "../model";

export interface ScanText {
  running: boolean;
  /** Empty before the first scan of this session. */
  text: string;
  /** The scan ran to its end and found no sent mail at all. */
  empty: boolean;
}

export function scanText(model: Model): ScanText {
  const scan = model.status.scan;
  if (scan === null) {
    return { running: false, text: "", empty: false };
  }
  if (scan.running) {
    const folder = scan.folder === null ? "" : folderView(model, scan.folder).name;
    return {
      running: true,
      empty: false,
      text:
        scan.folder === null
          ? t("scanStarting")
          : scan.total === null
            ? t("scanRunning", scan.folderIndex, scan.folderCount, folder, scan.scanned, scan.added)
            : t("scanRunningOf", scan.folderIndex, scan.folderCount, folder, scan.scanned, scan.added, Math.max(scan.total, scan.scanned)),
    };
  }
  const empty = scanIsComplete(scan) && scan.scanned === 0;
  const summary = empty ? t("scanDoneEmpty") : t(scan.cancelled ? "scanCancelled" : "scanDone", scan.scanned, scan.added);
  // A folder that could not be read is named with what went wrong: "/Sent: ...".
  const problems = scan.errors.map((error) => {
    const separator = error.indexOf(": ");
    return separator === -1 ? error : `${error.slice(0, separator)}: ${diagnosticText(error.slice(separator + 2))}`;
  });
  return { running: false, empty, text: problems.length > 0 ? `${summary} ${t("scanErrors", problems.join("; "))}` : summary };
}

export interface ScanStatusView {
  element: HTMLElement;
  update(model: Model): void;
}

/**
 * The progress and the result of the scan. The element is kept and only updated, so
 * that the progress bar moves on instead of starting anew with every report. With
 * `onCheckFolders`, a scan that found no sent mail offers the way to the Sent folders.
 */
export function scanStatusView(onCheckFolders: (() => void) | null = null): ScanStatusView {
  const bar = h("progress", { hidden: true, attrs: { "aria-label": t("scanProgressLabel") } });
  const text = h("span");
  const link =
    onCheckFolders === null
      ? null
      : h("a", {
          href: "#learning",
          text: t("scanCheckFolders"),
          hidden: true,
          onclick: (event) => {
            event.preventDefault();
            onCheckFolders();
          },
        });
  const line = h("p", { attrs: { role: "status" } }, text, link === null ? null : " ", link);
  const element = h("div", { class: "scan-status" }, bar, line);
  return {
    element,
    update(model) {
      const scan = model.status.scan;
      const said = scanText(model);
      bar.hidden = !said.running;
      if (said.running && scan !== null && scan.total !== null && scan.total > 0) {
        bar.max = Math.max(scan.total, scan.scanned);
        bar.value = scan.scanned;
      } else {
        // How far is not known: the bar says only that the scan is running.
        bar.removeAttribute("value");
      }
      // The numbers change every second while the scan runs: they are read out when it ends, not all the time.
      line.setAttribute("aria-live", said.running ? "off" : "polite");
      if (text.textContent !== said.text) {
        text.textContent = said.text;
      }
      if (link !== null) {
        link.hidden = !said.empty;
      }
      element.hidden = said.text === "";
    },
  };
}
