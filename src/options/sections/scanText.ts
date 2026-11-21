// The progress of the manual scan in words. The Overview and the Learning pane show
// the same scan.

import { t } from "../../tb/i18n";
import { folderView } from "../model";
import type { Model } from "../model";

export interface ScanText {
  running: boolean;
  /** Empty before the first scan of this session. */
  text: string;
}

export function scanText(model: Model): ScanText {
  const scan = model.status.scan;
  if (scan === null) {
    return { running: false, text: "" };
  }
  if (scan.running) {
    return {
      running: true,
      text:
        scan.folder === null
          ? t("scanStarting")
          : t("scanRunning", scan.folderIndex, scan.folderCount, folderView(model, scan.folder).name, scan.scanned, scan.added),
    };
  }
  const summary = t(scan.cancelled ? "scanCancelled" : "scanDone", scan.scanned, scan.added);
  return { running: false, text: scan.errors.length > 0 ? `${summary} ${t("scanErrors", scan.errors.join("; "))}` : summary };
}
