// All user-visible strings live in _locales. This is the only way to read them.

/** Returns the localized message, with $1, $2... replaced by the substitutions. */
export function t(key: string, ...substitutions: (string | number)[]): string {
  const message = browser.i18n.getMessage(
    key,
    substitutions.map((value) => String(value)),
  );
  return message === "" ? key : message;
}

/**
 * The message for a code such as a log reason or an access point type. Message
 * names may not contain hyphens, so "no-verdict" under "outcome" reads "outcome_no_verdict".
 */
export function tCode(prefix: string, code: string, ...substitutions: (string | number)[]): string {
  return t(`${prefix}_${code.replace(/[^A-Za-z0-9]/g, "_")}`, ...substitutions);
}

/**
 * Fills in the static text of a page: elements with data-i18n get their text,
 * data-i18n-placeholder and data-i18n-title set the matching attributes.
 */
export function localizePage(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n ?? "");
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]")) {
    element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder ?? ""));
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    element.setAttribute("title", t(element.dataset.i18nTitle ?? ""));
  }
}
