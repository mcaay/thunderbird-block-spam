// Figures for the status line of the settings page, computed from the log and the AI services.

import { isAvailable } from "./chain";
import type { AccessPoint, LogEntry } from "./types";

export interface DaySummary {
  /** Incoming messages that were decided. */
  checked: number;
  /** Of those, moved to Junk. */
  junk: number;
  /** Of those, scored by an AI service. */
  scored: number;
}

/**
 * Counts the decisions about incoming mail logged from `dayStart` on. Test scores and
 * releases from a screening folder are not decisions about new mail. An observed
 * decision counts as checked, but it moved nothing.
 */
export function summarizeDay(entries: readonly LogEntry[], dayStart: number): DaySummary {
  const summary: DaySummary = { checked: 0, junk: 0, scored: 0 };
  for (const entry of entries) {
    if (entry.time < dayStart || entry.test || entry.outcome === "released") {
      continue;
    }
    summary.checked += 1;
    if (entry.action === "junk" && !entry.observed) {
      summary.junk += 1;
    }
    if (entry.score !== null) {
      summary.scored += 1;
    }
  }
  return summary;
}

export interface AiHealth {
  /** Services that are switched on. */
  enabled: number;
  /** Of those, services that would be asked now: not paused and not needing attention. */
  working: number;
}

export function aiHealth(points: readonly AccessPoint[], now: number): AiHealth {
  return {
    enabled: points.filter((point) => point.enabled).length,
    working: points.filter((point) => isAvailable(point, now)).length,
  };
}
