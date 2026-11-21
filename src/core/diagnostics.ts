// What the add-on itself says about a request to an AI service that failed. The
// texts are stored with the service and written to the log in English, as
// diagnostics. The pages say the part the add-on wrote in the language of the
// interface and quote only the service's own message, see parseDiagnostic.

/** Fixed diagnostics, and the code under which the pages translate each. */
const FIXED = {
  answerMissing: ["the answer is missing", "answer-missing"],
  answerEmpty: ["the answer is empty", "answer-missing"],
  refused: ["the model refused to answer", "refused"],
  notProbability: ["the answer is not a probability", "not-number"],
  notNumber: ["the answer is not a number from 0.00 to 1.00", "not-number"],
  invalidScore: ["invalid score", "not-number"],
  cutOff: ["the answer was cut off", "cut-off"],
  incomplete: ["the answer is incomplete", "cut-off"],
  endedEarly: ["the answer ended early", "cut-off"],
  tooLarge: ["the answer is too large", "too-large"],
  tooLong: ["the answer is too long", "too-large"],
  noModelSet: ["no model is set", "no-model"],
  noModelSelected: ["no model is selected", "no-model"],
  notSignedIn: ["not signed in", "not-signed-in"],
  endpointInvalid: ["the endpoint address is not valid", "endpoint-invalid"],
} as const;

type FixedName = keyof typeof FIXED;

/** The fixed diagnostics by name, for the code that reports them. */
export const DIAGNOSTICS = Object.fromEntries(Object.entries(FIXED).map(([name, [text]]) => [name, text])) as {
  [Name in FixedName]: (typeof FIXED)[Name][0];
};

/** The codes a diagnostic can have. The pages hold one sentence per code. */
export const DIAGNOSTIC_CODES = [
  "http",
  "timeout",
  "network",
  "usage-limit",
  "renew-failed",
  "no-permission",
  "service",
  "answer-missing",
  "refused",
  "not-number",
  "cut-off",
  "too-large",
  "no-model",
  "not-signed-in",
  "endpoint-invalid",
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

/** The service answered with an HTTP error status. The text is the service's own message, or empty. */
export function httpDiagnostic(status: number, text: string): string {
  return text === "" ? `HTTP ${status}` : `HTTP ${status}: ${text}`;
}

export function timeoutDiagnostic(seconds: number): string {
  return `no answer within ${seconds} seconds`;
}

/** The request never reached the service. The text is what the platform reported. */
export function networkDiagnostic(text: string): string {
  return `network error: ${text}`;
}

export function usageLimitDiagnostic(text: string): string {
  return `usage limit reached: ${text}`;
}

export function renewDiagnostic(text: string): string {
  return `sign-in could not be renewed: ${text}`;
}

export function permissionDiagnostic(origin: string): string {
  return `no permission for ${origin}: open the access point and save it`;
}

/** A refusal in the service's own words, with nothing of the add-on's to add. */
export function serviceDiagnostic(text: string): string {
  return `the service answered: ${text}`;
}

export interface Diagnostic {
  code: DiagnosticCode;
  /** What the sentence of the code names: the status, the seconds, the host. */
  args: string[];
  /** Text that is quoted as it is: the service's own message, or what the platform reported. Empty when there is none. */
  detail: string;
  /** Who wrote the detail. */
  from: "service" | "platform";
}

const PATTERNS: readonly [RegExp, DiagnosticCode, "arg" | "detail" | "both", Diagnostic["from"]][] = [
  [/^HTTP (\d{3})(?:: ([\s\S]+))?$/, "http", "both", "service"],
  [/^no answer within (\d+) seconds$/, "timeout", "arg", "service"],
  [/^network error: ([\s\S]*)$/, "network", "detail", "platform"],
  [/^usage limit reached: ([\s\S]*)$/, "usage-limit", "detail", "service"],
  [/^sign-in could not be renewed: ([\s\S]*)$/, "renew-failed", "detail", "service"],
  [/^no permission for (\S+): open the access point and save it$/, "no-permission", "arg", "service"],
  [/^the service answered: ([\s\S]*)$/, "service", "detail", "service"],
];

/**
 * Takes a diagnostic apart into the part the add-on wrote and the part it quotes.
 * Null for any other text, for example the message of an unexpected exception.
 */
export function parseDiagnostic(text: string): Diagnostic | null {
  for (const [fixed, code] of Object.values(FIXED)) {
    if (text === fixed) {
      return { code, args: [], detail: "", from: "service" };
    }
  }
  for (const [pattern, code, shape, from] of PATTERNS) {
    const match = pattern.exec(text);
    if (match === null) {
      continue;
    }
    const first = match[1] ?? "";
    if (shape === "arg") {
      return { code, args: [first], detail: "", from };
    }
    if (shape === "detail") {
      // A nested diagnostic of the add-on's own, such as "HTTP 500" for a renewal, is not quoted as the service's words.
      return { code, args: [], detail: parseDiagnostic(first) === null && first !== "unexpected answer" ? first : "", from };
    }
    return { code, args: [first], detail: match[2] ?? "", from };
  }
  return null;
}

/**
 * The attempts of a decision without a verdict, as the log stores them
 * ("Jev: HTTP 500; OpenAI: HTTP 429"), taken apart. Null when the text is not such a list.
 */
export function parseAttempts(detail: string): { accessPoint: string; error: string }[] | null {
  const attempts: { accessPoint: string; error: string }[] = [];
  for (const part of detail.split("; ")) {
    const separator = part.indexOf(": ");
    const last = attempts.at(-1);
    if (separator > 0 && parseDiagnostic(part.slice(separator + 2)) !== null) {
      attempts.push({ accessPoint: part.slice(0, separator), error: part.slice(separator + 2) });
    } else if (last !== undefined) {
      // A message of a service that contains the separator itself.
      last.error = `${last.error}; ${part}`;
    } else {
      return null;
    }
  }
  return attempts.length === 0 ? null : attempts;
}
