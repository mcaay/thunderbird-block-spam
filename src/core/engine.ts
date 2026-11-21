// Orchestration of learning, the incoming pipeline, sweeps, scans and commands.
// Everything here works against ports, so it runs unchanged under test.

import { normalizeAddress } from "./address";
import { AccessPointError } from "./chain";
import { applyCommand } from "./commands";
import type { CommandMessage, CommandName, CommandPlan } from "./commands";
import { decideMessage, errorText, MessageReader, REASONS, scorePayload } from "./decision";
import type { DecisionDeps } from "./decision";
import { resolveMonitoredFolders, resolveSentFolders } from "./folders";
import { learnRecipients, syncIdentities } from "./learning";
import { matchSender } from "./lists";
import { SAMPLE_PAYLOAD } from "./payload";
import type { AiPort, MailPort } from "./ports";
import { folderKey, sameFolder } from "./ports";
import { processedId } from "./processed";
import { isSpam } from "./score";
import type { AppState } from "./state";
import type { AccessPoint, FolderRef, LogEntry, MessageInfo } from "./types";

/** Queries reach back this far before the previous tick, to catch late arrivals. */
export const WINDOW_MS = 48 * 60 * 60 * 1000;
const MOVE_BATCH = 100;

export interface EngineDeps {
  state: AppState;
  mail: MailPort;
  ai: AiPort;
  now: () => number;
  /** Non-fatal problems, for the console. */
  warn?: (message: string, error?: unknown) => void;
}

/** Account and folder facts looked up once per job. */
interface Context {
  own: Set<string>;
  accountName(accountId: string): string;
  junk(accountId: string): FolderRef | null;
  inbox(accountId: string): FolderRef | null;
  isJunk(folder: FolderRef | null): boolean;
  inboxes: FolderRef[];
  sentDefaults: FolderRef[];
}

export interface ScanOptions {
  /** Start of the range, inclusive, epoch milliseconds. Null for no start. */
  from: number | null;
  /** End of the range, exclusive, epoch milliseconds. Null for no end. */
  to: number | null;
}

export interface ScanProgress {
  running: boolean;
  cancelled: boolean;
  folderIndex: number;
  folderCount: number;
  folder: FolderRef | null;
  scanned: number;
  added: number;
  errors: string[];
}

export interface CommandOutcome {
  plan: CommandPlan;
  moved: number;
  failures: string[];
}

export interface TestScoreSummary {
  scored: number;
  failed: number;
}

export type AccessPointTestResult = { ok: true; score: number } | { ok: false; error: string };

export class Engine {
  private sweeping = false;
  private sweepAgain = false;

  constructor(private readonly deps: EngineDeps) {}

  private warn(message: string, error?: unknown): void {
    this.deps.warn?.(message, error);
  }

  private async context(): Promise<Context> {
    const { mail } = this.deps;
    const [accounts, identities, junkFolders, inboxes, sentDefaults] = await Promise.all([
      mail.accounts(),
      mail.identities(),
      mail.specialFolders("junk"),
      mail.specialFolders("inbox"),
      mail.specialFolders("sent"),
    ]);
    const names = new Map(accounts.map((account) => [account.id, account.name]));
    const own = new Set<string>();
    for (const identity of identities) {
      const address = normalizeAddress(identity.email);
      if (address !== null) {
        own.add(address);
      }
    }
    const first = (folders: FolderRef[], accountId: string): FolderRef | null =>
      folders.find((folder) => folder.accountId === accountId) ?? null;
    return {
      own,
      accountName: (accountId) => names.get(accountId) ?? accountId,
      junk: (accountId) => first(junkFolders, accountId),
      inbox: (accountId) => first(inboxes, accountId),
      isJunk: (folder) => junkFolders.some((junk) => sameFolder(junk, folder)),
      inboxes,
      sentDefaults,
    };
  }

  private decisionDeps(context: Context): DecisionDeps {
    return {
      state: this.deps.state,
      mail: this.deps.mail,
      ai: this.deps.ai,
      now: this.deps.now,
      accountName: context.accountName,
      junkFolder: async (accountId) => context.junk(accountId),
    };
  }

  /**
   * The idempotent job behind startup and the 5 minute alarm: identities, the Sent
   * folder watch, incoming mail while protection is on, and the screening sweep.
   */
  async tick(): Promise<void> {
    const { state, now } = this.deps;
    const started = now();
    const context = await this.context();

    if (syncIdentities(state.entries, context.own, state.publicDomains, started) > 0) {
      state.whiteAdded = true;
      await state.saveEntries();
    }
    await this.watchSentFolders(context);
    if (state.settings.protection) {
      await this.handleMonitoredFolders(context, started);
    }
    if (state.whiteAdded) {
      await this.sweepScreening(context);
    }
    await state.setLastTick(started);
    await state.pruneProcessed(started);
  }

  /** Learns from sent messages dated after the previous tick minus 48 hours. */
  private async watchSentFolders(context: Context): Promise<void> {
    const { state, mail, now } = this.deps;
    const installedAt = state.settings.installedAt;
    const since = Math.max(installedAt, (state.lastTick ?? installedAt) - WINDOW_MS);
    for (const folder of resolveSentFolders(context.sentDefaults, state.settings)) {
      try {
        for await (const page of mail.messagesSince(folder, since)) {
          const fresh: { id: string; date: number }[] = [];
          let changed = 0;
          for (const message of page) {
            const id = await processedId(message);
            if (state.isProcessed("sent", id)) {
              continue;
            }
            changed += await this.learnMessage(message, context.own, "sent");
            fresh.push({ id, date: message.date });
          }
          if (changed > 0) {
            state.whiteAdded = true;
            await state.saveEntries();
          }
          await state.markProcessedMany("sent", fresh, now());
        }
      } catch (error) {
        this.warn(`Sent folder ${folder.path} could not be read`, error);
      }
    }
  }

  /** Learns the To, Cc and Bcc recipients of one sent message. Returns the number of changed entries. */
  private async learnMessage(message: MessageInfo, own: ReadonlySet<string>, source: "sent" | "scan"): Promise<number> {
    const { state, mail, now } = this.deps;
    const addresses: string[] = [];
    for (const raw of [...message.recipients, ...message.ccList, ...message.bccList]) {
      if (raw.trim() === "") {
        continue;
      }
      try {
        addresses.push(...(await mail.parseAddresses(raw)));
      } catch (error) {
        this.warn("A recipient could not be parsed", error);
      }
    }
    return learnRecipients(
      {
        entries: state.entries,
        publicDomains: state.publicDomains,
        ownAddresses: own,
        accountId: message.accountId,
        scope: state.newEntryScope(message.accountId),
        source,
        now: now(),
      },
      addresses,
    ).changed;
  }

  /** Live send: teaches the recipients immediately. */
  async learnFromSend(accountId: string, rawRecipients: readonly string[]): Promise<void> {
    const { state } = this.deps;
    const context = await this.context();
    const message: MessageInfo = {
      id: 0,
      accountId,
      folder: null,
      headerMessageId: "",
      author: "",
      recipients: [...rawRecipients],
      ccList: [],
      bccList: [],
      subject: "",
      date: 0,
      size: 0,
    };
    if ((await this.learnMessage(message, context.own, "sent")) > 0) {
      state.whiteAdded = true;
      await state.saveEntries();
      await this.sweepScreening(context);
    }
  }

  /** Handles monitored folders: every message dated after the window start that was not processed yet. */
  private async handleMonitoredFolders(context: Context, started: number): Promise<void> {
    const { state, mail } = this.deps;
    const since = Math.max(state.settings.protectionOnAt ?? started, (state.lastTick ?? started) - WINDOW_MS);
    for (const folder of resolveMonitoredFolders(context.inboxes, state.settings)) {
      try {
        for await (const page of mail.messagesSince(folder, since)) {
          for (const message of page) {
            if (!state.settings.protection) {
              return;
            }
            await this.handleIncoming(context, message);
          }
        }
      } catch (error) {
        this.warn(`Folder ${folder.path} could not be read`, error);
      }
    }
  }

  /**
   * Fast path for messages.onNewMailReceived. Uses the same handler as the tick.
   * Mail dated before protection was switched on is never handled.
   */
  async handleNewMail(folder: FolderRef, pages: AsyncIterable<MessageInfo[]>): Promise<void> {
    const { state } = this.deps;
    if (!state.settings.protection) {
      return;
    }
    const context = await this.context();
    const monitored = resolveMonitoredFolders(context.inboxes, state.settings);
    if (!monitored.some((candidate) => sameFolder(candidate, folder))) {
      return;
    }
    const protectionOnAt = state.settings.protectionOnAt ?? 0;
    for await (const page of pages) {
      for (const message of page) {
        if (!state.settings.protection) {
          return;
        }
        if (message.date === 0 || message.date > protectionOnAt) {
          await this.handleIncoming(context, message);
        }
      }
    }
  }

  private async handleIncoming(context: Context, message: MessageInfo): Promise<void> {
    const { state, now } = this.deps;
    const id = await processedId(message);
    if (state.isProcessed("in", id)) {
      return;
    }
    let entry: LogEntry;
    try {
      entry = await decideMessage(this.decisionDeps(context), message);
    } catch (error) {
      // Every failure leaves mail where it is. The message is not retried.
      entry = {
        time: now(),
        accountId: message.accountId,
        account: context.accountName(message.accountId),
        sender: "",
        via: "",
        subject: message.subject,
        outcome: "error",
        action: "none",
        score: null,
        accessPoint: "",
        reason: "failed",
        detail: errorText(error),
        observed: state.settings.observation,
        test: false,
      };
    }
    await state.log(entry);
    await state.markProcessed("in", id, now(), message.date);
  }

  /** Runs the screening sweep when a white list entry was added since the last one. */
  async sweepIfNeeded(): Promise<void> {
    if (this.deps.state.whiteAdded) {
      await this.sweepScreening(await this.context());
    }
  }

  /**
   * Moves messages from whitelisted senders out of screening folders, to the Inbox
   * of their account.
   */
  private async sweepScreening(context: Context): Promise<void> {
    if (this.sweeping) {
      this.sweepAgain = true;
      return;
    }
    this.sweeping = true;
    try {
      do {
        this.sweepAgain = false;
        this.deps.state.whiteAdded = false;
        await this.sweepOnce(context);
      } while (this.sweepAgain);
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepOnce(context: Context): Promise<void> {
    const { state, mail, now } = this.deps;
    for (const folder of state.settings.screeningFolders) {
      const inbox = context.inbox(folder.accountId);
      if (inbox === null || sameFolder(inbox, folder)) {
        continue;
      }
      const release: { message: MessageInfo; entry: LogEntry }[] = [];
      try {
        for await (const page of mail.allMessages(folder)) {
          for (const message of page) {
            const effective = await new MessageReader(mail, message).effectiveSender(state);
            if (effective.sender === null) {
              continue;
            }
            const match = matchSender(state.entries, effective.sender, message.accountId);
            if (match === null || match.list !== "white") {
              continue;
            }
            release.push({
              message,
              entry: {
                time: now(),
                accountId: message.accountId,
                account: context.accountName(message.accountId),
                sender: effective.sender.address,
                via: effective.forwarder ?? "",
                subject: message.subject,
                outcome: "released",
                action: "inbox",
                score: null,
                accessPoint: "",
                reason: REASONS.whitelisted,
                detail: `${match.value} [${match.scope}]`,
                observed: false,
                test: false,
              },
            });
          }
        }
      } catch (error) {
        this.warn(`Screening folder ${folder.path} could not be read`, error);
      }
      for (let start = 0; start < release.length; start += MOVE_BATCH) {
        const batch = release.slice(start, start + MOVE_BATCH);
        let failure = "";
        try {
          await mail.move(
            batch.map((item) => item.message.id),
            inbox,
          );
        } catch (error) {
          failure = errorText(error);
        }
        for (const item of batch) {
          if (failure !== "") {
            item.entry.action = "none";
            item.entry.reason = REASONS.moveFailed;
            item.entry.detail = `${item.entry.detail}; ${failure}`;
          }
          await state.log(item.entry);
        }
      }
    }
  }

  /**
   * Manual scan of the configured Sent folders. Ignores the processed set, so
   * running it again is harmless. Entries learned before a cancel are kept.
   */
  async scan(
    options: ScanOptions,
    onProgress: (progress: ScanProgress) => void,
    isCancelled: () => boolean,
  ): Promise<ScanProgress> {
    const { state, mail } = this.deps;
    const context = await this.context();
    const folders = resolveSentFolders(context.sentDefaults, state.settings);
    const progress: ScanProgress = {
      running: true,
      cancelled: false,
      folderIndex: 0,
      folderCount: folders.length,
      folder: null,
      scanned: 0,
      added: 0,
      errors: [],
    };
    onProgress({ ...progress });

    scanning: for (const [index, folder] of folders.entries()) {
      progress.folderIndex = index + 1;
      progress.folder = folder;
      onProgress({ ...progress });
      try {
        const pages =
          options.from === null && options.to === null
            ? mail.allMessages(folder)
            : mail.messagesSince(folder, options.from ?? 0, options.to ?? undefined);
        for await (const page of pages) {
          let changed = 0;
          for (const message of page) {
            if (isCancelled()) {
              break;
            }
            changed += await this.learnMessage(message, context.own, "scan");
            progress.scanned += 1;
          }
          if (changed > 0) {
            progress.added += changed;
            await state.saveEntries();
          }
          onProgress({ ...progress });
          if (isCancelled()) {
            progress.cancelled = true;
            break scanning;
          }
        }
      } catch (error) {
        progress.errors.push(`${folder.path}: ${errorText(error)}`);
        this.warn(`Sent folder ${folder.path} could not be scanned`, error);
      }
    }

    // After a manual scan the screening sweep runs once, at the end.
    if (progress.added > 0) {
      state.whiteAdded = true;
      await this.sweepScreening(context);
    }
    progress.running = false;
    progress.folder = null;
    onProgress({ ...progress });
    return progress;
  }

  /** A shortcut command on the given messages: entries first, then the moves. */
  async runCommand(command: CommandName, messages: readonly MessageInfo[]): Promise<CommandOutcome> {
    const { state, mail, now } = this.deps;
    const context = await this.context();
    const screening = new Set(state.settings.screeningFolders.map(folderKey));
    const selected: CommandMessage[] = [];
    for (const message of messages) {
      const effective = await new MessageReader(mail, message).effectiveSender(state);
      const location = context.isJunk(message.folder)
        ? "junk"
        : message.folder !== null && screening.has(folderKey(message.folder))
          ? "screening"
          : "other";
      selected.push({ message, effective, location });
    }

    const plan = applyCommand(state, command, selected, context.own, now());
    if (plan.entriesChanged) {
      await state.saveEntries();
    }

    const outcome: CommandOutcome = { plan, moved: 0, failures: [] };
    const byAccount = new Map<string, MessageInfo[]>();
    for (const message of plan.moves) {
      if (message.folder === null) {
        continue; // a message opened from a file cannot be moved
      }
      const group = byAccount.get(message.accountId) ?? [];
      group.push(message);
      byAccount.set(message.accountId, group);
    }
    for (const [accountId, group] of byAccount) {
      const target = plan.list === "black" ? context.junk(accountId) : context.inbox(accountId);
      if (target === null) {
        outcome.failures.push(plan.list === "black" ? REASONS.noJunkFolder : "no-inbox-folder");
        continue;
      }
      const ids = group.filter((message) => !sameFolder(message.folder, target)).map((message) => message.id);
      for (let start = 0; start < ids.length; start += MOVE_BATCH) {
        const batch = ids.slice(start, start + MOVE_BATCH);
        try {
          await mail.move(batch, target);
          outcome.moved += batch.length;
        } catch (error) {
          outcome.failures.push(errorText(error));
        }
      }
    }

    if (state.whiteAdded) {
      await this.sweepScreening(context);
    }
    return outcome;
  }

  /**
   * Scores the given messages regardless of the lists and writes the scores to the
   * log marked as tests. Moves nothing and creates no entries.
   */
  async scoreSelected(messages: readonly MessageInfo[]): Promise<TestScoreSummary> {
    const { state, mail, now } = this.deps;
    const context = await this.context();
    const summary: TestScoreSummary = { scored: 0, failed: 0 };
    for (const message of messages) {
      const reader = new MessageReader(mail, message);
      const effective = await reader.effectiveSender(state);
      const result = await scorePayload(this.deps, await reader.payload(effective));
      const entry: LogEntry = {
        time: now(),
        accountId: message.accountId,
        account: context.accountName(message.accountId),
        sender: effective.sender?.address ?? "",
        via: effective.forwarder ?? "",
        subject: message.subject,
        outcome: "no-verdict",
        action: "none",
        score: null,
        accessPoint: "",
        reason: result.available ? REASONS.aiFailed : REASONS.noAi,
        detail: result.attempts.map((attempt) => `${attempt.accessPoint}: ${attempt.error}`).join("; "),
        observed: false,
        test: true,
      };
      if (result.verdict === null) {
        summary.failed += 1;
      } else {
        summary.scored += 1;
        const spam = isSpam(result.verdict.score, state.settings.cutoff);
        entry.score = result.verdict.score;
        entry.accessPoint = result.verdict.accessPoint;
        entry.outcome = spam ? "spam" : "passed";
        entry.reason = spam ? REASONS.aiAbove : REASONS.aiBelow;
        entry.detail = "";
      }
      await state.log(entry);
    }
    return summary;
  }

  /** The Test button: scores the built-in sample email with one access point. */
  async testAccessPoint(point: AccessPoint): Promise<AccessPointTestResult> {
    const { state, ai } = this.deps;
    try {
      const score = await ai.score(point, state.settings.prompt, SAMPLE_PAYLOAD);
      if (point.needsAttention || point.cooldownUntil !== 0 || point.lastError !== "") {
        point.needsAttention = false;
        point.cooldownUntil = 0;
        point.lastError = "";
        await state.saveAccessPoints();
      }
      return { ok: true, score };
    } catch (error) {
      const message = error instanceof AccessPointError ? error.message : errorText(error);
      return { ok: false, error: message };
    }
  }
}
