// Optional permission requests of the settings page.
//
// Thunderbird only accepts permissions.request while a click is being handled:
// after the first await the request is refused. So a request that failed cannot be
// repeated in another form within the same click, unless it failed synchronously.
// This module therefore finds out up front what Thunderbird supports, tries the
// alternative forms synchronously, and, when a form is refused later, remembers
// that and asks the user to press the button again.

import { t } from "../tb/i18n";

/** Declared as optional data collection in the manifest. Granted together with the first AI host. */
export const DATA_COLLECTION: readonly string[] = ["personalCommunications", "personallyIdentifyingInfo"];
/** Needed with webRequest to read the ChatGPT sign-in redirect. */
export const LOOPBACK_ORIGIN = "http://127.0.0.1/*";
const WEB_REQUEST = "webRequest";

const support = {
  /** permissions.request understands data_collection. Unknown until detected, so off. */
  dataCollection: false,
  /** webRequest can be requested as an optional permission. */
  webRequest: true,
};

/** Finds out which optional features this Thunderbird supports. Called when the page loads. */
export async function detectPermissionSupport(): Promise<void> {
  try {
    const granted = await browser.permissions.getAll();
    support.dataCollection = Array.isArray(granted.data_collection);
  } catch {
    support.dataCollection = false;
  }
  try {
    const optional = browser.runtime.getManifest().optional_permissions;
    support.webRequest = Array.isArray(optional) && optional.includes(WEB_REQUEST);
  } catch {
    support.webRequest = true;
  }
}

/** The forms of a request, from the most complete to the plainest. */
function requestForms(origins: readonly string[], permissions: readonly string[]): tb.PermissionSet[] {
  const wantsWebRequest = permissions.includes(WEB_REQUEST);
  // Without webRequest the loopback address that came with it is not needed either.
  const plain: tb.PermissionSet = {
    origins: wantsWebRequest ? origins.filter((origin) => origin !== LOOPBACK_ORIGIN) : [...origins],
    permissions: permissions.filter((permission) => permission !== WEB_REQUEST),
  };
  const bases: tb.PermissionSet[] =
    wantsWebRequest && support.webRequest ? [{ origins: [...origins], permissions: [...permissions] }, plain] : [plain];
  const forms: tb.PermissionSet[] = [];
  for (const base of bases) {
    if (support.dataCollection) {
      forms.push({ ...base, data_collection: [...DATA_COLLECTION] });
    }
    forms.push(base);
  }
  return forms;
}

/**
 * Requests host permissions, optional API permissions and, where supported, the
 * data collection permission. Must be called synchronously from a click handler.
 * Resolves to false when the user declines.
 */
export function requestAccess(origins: readonly string[], permissions: readonly string[] = []): Promise<boolean> {
  let chosen: tb.PermissionSet | null = null;
  let pending: Promise<boolean> | null = null;
  let firstError: unknown = null;
  for (const form of requestForms(origins, permissions)) {
    try {
      pending = browser.permissions.request(form);
      chosen = form;
      break;
    } catch (error) {
      // Refused at once: still inside the click, so the next form can be tried.
      firstError ??= error;
    }
  }
  if (pending === null || chosen === null) {
    return Promise.reject(firstError ?? new Error(t("permissionDeclined")));
  }
  const used = chosen;
  if (used.data_collection === undefined) {
    support.dataCollection = false;
  }
  if (permissions.includes(WEB_REQUEST) && used.permissions?.includes(WEB_REQUEST) !== true) {
    support.webRequest = false;
  }
  return pending.catch((error: unknown) => {
    // Refused after the click ended. Drop the most optional part and let the user try again.
    if (used.data_collection !== undefined) {
      support.dataCollection = false;
    } else if (used.permissions?.includes(WEB_REQUEST) === true) {
      support.webRequest = false;
    } else {
      throw error;
    }
    throw new Error(t("permissionTryAgain"));
  });
}

/** For tests. */
export function permissionSupport(): { dataCollection: boolean; webRequest: boolean } {
  return { ...support };
}

export function resetPermissionSupport(): void {
  support.dataCollection = false;
  support.webRequest = true;
}
