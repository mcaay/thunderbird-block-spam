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

export type PluralForm = "one" | "few" | "many";

/**
 * The language of the strings in use. The locale file names its own language in
 * "localeCode". It can differ from the language of Thunderbird: a Thunderbird in a
 * language without a translation shows the English strings, and then counts and
 * numbers have to be written the English way as well.
 */
export function stringsLocale(): string {
  const code = t("localeCode");
  return /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(code) ? code : "en";
}

let pluralRules: Intl.PluralRules | null = null;

/** The plural form of a count in the language of the strings. English uses "one" and "many", Polish all three. */
export function pluralForm(count: number): PluralForm {
  pluralRules ??= new Intl.PluralRules(stringsLocale());
  const category = pluralRules.select(count);
  return category === "one" ? "one" : category === "few" ? "few" : "many";
}

/**
 * The message for a count: "<key>_one", "<key>_few" or "<key>_many", with the count
 * as $1 and the other substitutions after it.
 */
export function tn(key: string, count: number, ...substitutions: (string | number)[]): string {
  return t(`${key}_${pluralForm(count)}`, count, ...substitutions);
}

/**
 * Fills in the static text of a page: elements with data-i18n get their text,
 * data-i18n-placeholder, data-i18n-title and data-i18n-aria-label set the matching
 * attributes. The document is marked with the language of the strings.
 */
export function localizePage(root: ParentNode = document): void {
  if (root === document) {
    document.documentElement.lang = stringsLocale();
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n-aria-label]")) {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel ?? ""));
  }
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
