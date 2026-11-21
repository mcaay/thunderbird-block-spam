// The decision for one incoming message (design section 5.2).

import { smartTarget } from "./address";
import { runChain } from "./chain";
import type { ChainResult } from "./chain";
import { resolveEffectiveSender } from "./forward";
import type { EffectiveSender } from "./forward";
import { matchSender } from "./lists";
import { buildPayload, MAX_BODY_MESSAGE_SIZE } from "./payload";
import type { AiPort, MailPort } from "./ports";
import { sameFolder } from "./ports";
import { isSpam } from "./score";
import type { AppState } from "./state";
import type { Action, Entry, FolderRef, LogEntry, MessageInfo, Outcome } from "./types";

/** Reason codes written to the log. The settings page translates them. */
export const REASONS = {
  whiteAddress: "white-address",
  whiteDomain: "white-domain",
  blackAddress: "black-address",
  blackDomain: "black-domain",
  aiAbove: "ai-above",
  aiBelow: "ai-below",
  noAi: "no-ai",
  aiFailed: "ai-failed",
  senderUnparsed: "sender-unparsed",
  noJunkFolder: "no-junk-folder",
  noScreeningFolder: "no-screening-folder",
  moveFailed: "move-failed",
  whitelisted: "whitelisted",
} as const;

/** Reads the expensive parts of a message at most once. */
export class MessageReader {
  private headersPromise: Promise<Record<string, string[]>> | null = null;
  private bodyPromise: Promise<string> | null = null;

  constructor(
    private readonly mail: MailPort,
    readonly message: MessageInfo,
  ) {}

  headers(): Promise<Record<string, string[]>> {
    this.headersPromise ??= this.mail.headers(this.message.id);
    return this.headersPromise;
  }

  /** Empty for messages over 5 MB. */
  bodyText(): Promise<string> {
    this.bodyPromise ??=
      this.message.size > MAX_BODY_MESSAGE_SIZE ? Promise.resolve("") : this.mail.bodyText(this.message.id);
    return this.bodyPromise;
  }

  effectiveSender(state: AppState): Promise<EffectiveSender> {
    return resolveEffectiveSender(this.message.author, state.forwardingMailboxes, state.settings.forwardLabels, {
      parseAddress: async (raw) => (await this.mail.parseAddresses(raw))[0] ?? null,
      headers: () => this.headers(),
      attachedMessageFrom: () => this.mail.attachedMessageFrom(this.message.id),
      bodyText: () => this.bodyText(),
    });
  }

  /** The text sent to the AI. A missing body or header never stops scoring. */
  async payload(effective: EffectiveSender): Promise<string> {
    let replyTo: string | null = null;
    try {
      replyTo = (await this.headers())["reply-to"]?.[0] ?? null;
    } catch {
      replyTo = null;
    }
    let body = "";
    try {
      body = await this.bodyText();
    } catch {
      body = "";
    }
    return buildPayload({
      from: effective.sender?.address ?? effective.forwarder ?? this.message.author,
      replyTo,
      to: this.message.recipients,
      subject: this.message.subject,
      date: this.message.date,
      body,
    });
  }
}

export interface DecisionDeps {
  state: AppState;
  mail: MailPort;
  ai: AiPort;
  now: () => number;
  accountName(accountId: string): string;
  junkFolder(accountId: string): Promise<FolderRef | null>;
}

/** Runs the chain with the current prompt and stores changed access point state. */
export async function scorePayload(deps: Pick<DecisionDeps, "state" | "ai" | "now">, payload: string): Promise<ChainResult> {
  const { state, ai, now } = deps;
  const result = await runChain(state.accessPoints, (point) => ai.score(point, state.settings.prompt, payload), now);
  if (result.stateChanged) {
    await state.saveAccessPoints();
  }
  return result;
}

function matchReason(entry: Entry): string {
  if (entry.list === "white") {
    return entry.kind === "address" ? REASONS.whiteAddress : REASONS.whiteDomain;
  }
  return entry.kind === "address" ? REASONS.blackAddress : REASONS.blackDomain;
}

function matchDetail(entry: Entry): string {
  return `${entry.value} [${entry.scope}]`;
}

/**
 * Decides one message and carries the decision out: writes the black list entry
 * first, then moves. In observation mode nothing is moved and no entry is written.
 * A failed move leaves the message where it is. Returns the log entry.
 */
export async function decideMessage(deps: DecisionDeps, message: MessageInfo): Promise<LogEntry> {
  const { state, mail, now } = deps;
  const { settings } = state;
  const reader = new MessageReader(mail, message);
  const effective = await reader.effectiveSender(state);

  const entry: LogEntry = {
    time: now(),
    accountId: message.accountId,
    account: deps.accountName(message.accountId),
    sender: effective.sender?.address ?? "",
    via: effective.forwarder ?? "",
    subject: message.subject,
    outcome: "error",
    action: "none",
    score: null,
    accessPoint: "",
    reason: "",
    detail: "",
    observed: settings.observation,
    test: false,
  };

  const finish = async (outcome: Outcome, action: Action, reason: string, detail: string): Promise<LogEntry> => {
    entry.outcome = outcome;
    entry.reason = reason;
    entry.detail = detail;
    entry.action = action;
    if (action === "none" || settings.observation) {
      return entry;
    }
    const target =
      action === "junk"
        ? await deps.junkFolder(message.accountId)
        : (settings.screeningFolders.find((folder) => folder.accountId === message.accountId) ?? null);
    if (target === null) {
      entry.action = "none";
      entry.reason = action === "junk" ? REASONS.noJunkFolder : REASONS.noScreeningFolder;
      return entry;
    }
    if (sameFolder(message.folder, target)) {
      entry.action = "none";
      return entry;
    }
    try {
      await mail.move([message.id], target);
    } catch (error) {
      entry.action = "none";
      entry.reason = REASONS.moveFailed;
      entry.detail = joinDetail(detail, errorText(error));
    }
    return entry;
  };

  // A message whose From cannot be parsed stays where it is.
  if (effective.sender === null && effective.forwarder === null) {
    return finish("error", "none", REASONS.senderUnparsed, message.author);
  }

  const byList = (match: Entry): Promise<LogEntry> =>
    match.list === "white"
      ? finish("trusted", "none", matchReason(match), matchDetail(match))
      : finish("blocked", "junk", matchReason(match), matchDetail(match));

  // For a wrapped forward whose original sender is unknown, the forwarding
  // mailbox's own list status is never used: the sender is simply unknown.
  const match = effective.sender === null ? null : matchSender(state.entries, effective.sender, message.accountId);
  if (match !== null) {
    return byList(match);
  }

  const noVerdict = (reason: string, detail: string): Promise<LogEntry> => {
    const action: Action =
      settings.noVerdictAction === "junk" ? "junk" : settings.noVerdictAction === "screening" ? "screening" : "none";
    return finish("no-verdict", action, reason, detail);
  };

  if (!state.accessPoints.some((point) => point.enabled)) {
    return noVerdict(REASONS.noAi, "");
  }

  const result = await scorePayload(deps, await reader.payload(effective));
  if (result.verdict === null) {
    return noVerdict(REASONS.aiFailed, result.attempts.map((attempt) => `${attempt.accessPoint}: ${attempt.error}`).join("; "));
  }
  entry.score = result.verdict.score;
  entry.accessPoint = result.verdict.accessPoint;

  // The lists may have changed while the AI was working (a shortcut, sent mail).
  // A list entry always outranks an AI verdict.
  const later = effective.sender === null ? null : matchSender(state.entries, effective.sender, message.accountId);
  if (later !== null) {
    return byList(later);
  }

  if (!isSpam(result.verdict.score, settings.cutoff)) {
    return finish("passed", "none", REASONS.aiBelow, "");
  }

  let detail = "";
  if (effective.sender !== null) {
    const target = smartTarget(effective.sender, state.publicDomains);
    const scope = state.newEntryScope(message.accountId);
    detail = `${target.value} [${scope}]`;
    if (!settings.observation) {
      // The black list entry is always written before the move.
      state.addEntry({ list: "black", kind: target.kind, value: target.value, scope, source: "ai" }, now());
      await state.saveEntries();
    }
  }
  return finish("spam", "junk", REASONS.aiAbove, detail);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function joinDetail(first: string, second: string): string {
  return first === "" ? second : `${first}; ${second}`;
}
