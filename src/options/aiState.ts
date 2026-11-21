// What the page says about the state of an AI service: whether this computer allows
// its host, and what to do when it needs attention.

import { requiredOrigins } from "../ai/presets";
import { remedyFor, signedIn } from "../core/problems";
import type { Remedy } from "../core/problems";
import type { AccessPoint } from "../core/types";

export { signedIn };
export type { Remedy };

/** Host permission patterns and whether they are granted, as far as the page has asked. */
const grants = new Map<string, boolean>();

/** False only when the page knows that a host of the service is not allowed on this computer. */
export function hostGranted(point: AccessPoint): boolean {
  return (requiredOrigins(point) ?? []).every((origin) => grants.get(origin) !== false);
}

/** Asks Thunderbird about the hosts of the given services. Resolves to true when something changed. */
export async function refreshGrants(points: readonly AccessPoint[]): Promise<boolean> {
  let changed = false;
  for (const origin of new Set(points.flatMap((point) => requiredOrigins(point) ?? []))) {
    let granted = true;
    try {
      granted = await browser.permissions.contains({ origins: [origin] });
    } catch {
      granted = true;
    }
    if (grants.get(origin) !== granted) {
      grants.set(origin, granted);
      changed = true;
    }
  }
  return changed;
}

/** Why a service needs attention, as far as the page knows what this computer allows. */
export function remedyOf(point: AccessPoint): Remedy {
  return remedyFor(point, hostGranted(point));
}
