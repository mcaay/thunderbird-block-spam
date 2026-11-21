// Diagnostics of failed AI requests in the language of the interface. The part the
// add-on wrote is translated; the service's own message is quoted as it came.

import { parseAttempts, parseDiagnostic } from "../core/diagnostics";
import { t, tCode } from "../tb/i18n";

/** What went wrong with a request, as a sentence. Text that is not a diagnostic of the add-on is returned as it is. */
export function diagnosticText(text: string): string {
  const parsed = parseDiagnostic(text);
  if (parsed === null) {
    return text;
  }
  const said = tCode("diag", parsed.code, ...parsed.args);
  if (parsed.detail === "") {
    return said;
  }
  return `${said} ${t(parsed.from === "service" ? "diagServiceSaid" : "diagPlatformSaid", parsed.detail)}`;
}

/** The same, always ending like a sentence, for use between other sentences. */
export function diagnosticSentence(text: string): string {
  const said = diagnosticText(text).trim();
  return /[.!?\u2026"\u201d]$/.test(said) ? said : `${said}.`;
}

/** The detail of a decision without a verdict: who was asked and what went wrong, one line per service. */
export function attemptsLines(detail: string): string[] {
  const attempts = parseAttempts(detail);
  return attempts === null ? [detail] : attempts.map((attempt) => `${attempt.accessPoint}: ${diagnosticSentence(attempt.error)}`);
}
