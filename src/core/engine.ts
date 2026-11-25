// Orchestration of learning, the incoming pipeline, sweeps, scans and commands.
// Everything here works against ports, so it runs unchanged under test.

import { normalizeAddress } from "./address";
import { AccessPointError } from "./chain";
import { applyCommand, commandEffect, COMMANDS, commandTarget } from "./commands";
import type { CommandMessage, CommandName, CommandPlan } from "./commands";
import { decideMessage, errorText, MessageReader, REASONS, scorePayload } from "./decision";
import type { DecisionDeps } from "./decision";
import { accountProtected, accountProtectedSince, resolveMonitoredFolders, resolveProtectedFolders, resolveSentFolders } from "./folders";
import { learnRecipients, syncIdentities } from "./learning";
import { entryKey, matchSender } from "./lists";
import { applyLogAction, expectsMove } from "./logAction";
import type { LogAction, LogChange } from "./logAction";
import { SAMPLE_PAYLOAD } from "./payload";
import type { AiPort, MailPort } from "./ports";
import { folderKey, sameFolder } from "./ports";
import { processedId } from "./processed";
import { isSpam } from "./score";
import type { AppState } from "./state";
import type { AccessPoint, Entry, FolderRef, ListName, LogEntry, MessageInfo, Scope, Target } from "./types";

/** Queries reach back this far before the previous tick, to catch late arrivals. */
export const WINDOW_MS = 48 * 60 * 60 * 1000;
const MOVE_BATCH = 100;
const RECIPIENT_CACHE_LIMIT = 5000;

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
  /**
   * How many messages the scan will read, when that is known: the Sent folders say how
   * many messages they hold, and the scan has no date limit. Null otherwise.
   */
  total: number | null;
}

/** One message a command moved: where it came from and where it went. */
export interface CommandMove {
  accountId: string;
  /** Message-ID header. The message is found again by it, since its number changes when it is moved. */
  messageId: string;
  from: FolderRef;
  to: FolderRef;
}

/** Everything needed to take a command back: the lists exactly as they were, and the messages to where they were. */
export interface CommandUndo {
  /** Keys of entries to remove. */
  remove: string[];
  /** Entries to put back exactly as they were. */
  restore: Entry[];
  moves: CommandMove[];
}

export interface CommandOutcome {
  plan: CommandPlan;
  moved: number;
  failures: string[];
  undo: CommandUndo;
}

export interface CommandUndoOutcome {
  /** Messages moved back. */
  moved: number;
  /** Messages that were no longer where the command had put them. */
  notFound: number;
  failures: string[];
  /** Where each message that was moved back is again: the Spam folder, the Inbox, or another folder. */
  back: { place: "junk" | "inbox" | "folder"; folder: FolderRef }[];
}

export interface TestScoreSummary {
  scored: number;
  failed: number;
}

export type AccessPointTestResult = { ok: true; score: number } | { ok: false; error: string };

/** The sender a command would act on, for the toolbar popup. */
export interface SenderInfo {
  /** Effective sender. Empty when it could not be determined. */
  address: string;
  /** Forwarding mailbox of a wrapped forward, otherwise empty. */
  via: string;
  /** The sender is one of the user's own addresses: commands ignore the message. */
  own: boolean;
  /** What the domain commands would add: the domain, or with Smart on the address of a sender at a public provider. */
  domainTarget: Target | null;
  /** The list entry that decides this sender now. Null when the sender is on neither list. */
  deciding: Entry | null;
  /** The account and the Message-ID of the message, for finding its decision in the log. The Message-ID may be empty. */
  accountId: string;
  messageId: string;
  /**
   * Commands that would change nothing: the sender is already decided that way, and
   * the message is where the command would put it.
   */
  unchanged: CommandName[];
  /**
   * What each command would do, for the tooltips of the buttons: the entry it puts on its list, the entries of the
   * other list it removes because they would still decide the sender, and whether it moves the message.
   */
  effects: Partial<Record<CommandName, CommandPreview>>;
}

export interface CommandPreview {
  target: Target;
  change: "added" | "moved" | "none";
  lifted: Target[];
  moves: boolean;
  /** The entry of the other list that decides the sender now and that the command would leave where it is. Null when there is none. */
  kept: { value: string; list: ListName } | null;
}

/**
 * What became of the message of a log action.
 * - none: the action moves nothing (the decision had moved nothing either).
 * - not-found: the message is no longer where the decision left it.
 * - no-folder: the account has no Junk folder, or no Inbox.
 */
export type MoveResult = "none" | "moved" | "not-found" | "no-folder" | "failed";

/** Everything needed to take a log action back. */
export interface LogActionUndo {
  accountId: string;
  messageId: string;
  /** Keys of entries to remove. */
  remove: string[];
  /** Entries to put back exactly as they were. */
  restore: Entry[];
  /** Where the message came from and where the action put it. Null when it was not moved. */
  move: { from: FolderRef; to: FolderRef } | null;
}

export interface LogActionOutcome {
  list: ListName;
  /** What changed on the lists, see LogChange. */
  change: LogChange;
  /** The entry that was added, moved or removed, or for "none" the entry that already decided. */
  target: Target;
  scope: Scope;
  /** For "remove": the white entry that decides the sender from then on. */
  behind: Target | null;
  move: MoveResult;
  /** Why the move failed, for "failed". */
  failure: string;
  undo: LogActionUndo;
}

/**
 * The time at the end of a Received header ("from ... by ...; Tue, 21 Nov 2026
 * 12:00:00 +0100 (CET)") in epoch milliseconds, or 0 when there is none.
 */
export function receivedTime(value: string): number {
  const separator = value.lastIndexOf(";");
  if (separator === -1) {
    return 0;
  }
  const time = Date.parse(value.slice(separator + 1).replace(/\([^()]*\)/g, " ").trim());
  return Number.isFinite(time) ? time : 0;
}

/**
 * Mail dates have whole seconds, so a moment is compared by its second. Without this,
 * a message that arrived in the second protection was switched on would be skipped.
 */
function wholeSecond(time: number): number {
  return Math.floor(time / 1000) * 1000;
}

export class Engine {
  private sweeping = false;
  private sweepAgain = false;
  /** Parsed recipient header values, to spare one parser call per repeated recipient. */
  private readonly parsedRecipients = new Map<string, string[]>();

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
   *
   * With sweep, the screening folders are checked even when no white list entry was
   * added since the last sweep. The request for a sweep lives in memory only, so one
   * that was due when Thunderbird closed would otherwise wait for the next addition.
   */
  async tick(options: { sweep?: boolean } = {}): Promise<void> {
    const { state, now } = this.deps;
    const started = now();
    if (options.sweep === true) {
      state.whiteAdded = true;
    }
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
        // The same recipients appear again and again in a Sent folder.
        let parsed = this.parsedRecipients.get(raw);
        if (parsed === undefined) {
          parsed = await mail.parseAddresses(raw);
          if (this.parsedRecipients.size >= RECIPIENT_CACHE_LIMIT) {
            this.parsedRecipients.clear();
          }
          this.parsedRecipients.set(raw, parsed);
        }
        addresses.push(...parsed);
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

  /** Handles monitored folders: every message dated from the window start on that was not processed yet. */
  private async handleMonitoredFolders(context: Context, started: number): Promise<void> {
    const { state, mail } = this.deps;
    const sinceAll = Math.max(wholeSecond(state.settings.protectionOnAt ?? started), (state.lastTick ?? started) - WINDOW_MS);
    for (const folder of resolveProtectedFolders(context.inboxes, state.settings)) {
      // An account that was switched on again by hand: mail that arrived in it before that moment is never touched.
      const since = Math.max(sinceAll, wholeSecond(accountProtectedSince(state.settings, folder.accountId)));
      try {
        pages: for await (const page of mail.messagesSince(folder, since)) {
          for (const message of page) {
            if (!state.settings.protection) {
              return;
            }
            if (!accountProtected(state.settings, folder.accountId)) {
              // Switched off while its mail was being handled: the rest of the account is left alone.
              break pages;
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
   * Mail that arrived before the second in which protection was switched on is never handled.
   */
  async handleNewMail(folder: FolderRef, pages: AsyncIterable<MessageInfo[]>): Promise<void> {
    const { state } = this.deps;
    if (!state.settings.protection) {
      return;
    }
    const context = await this.context();
    // A folder of an account whose protection is switched off is not among them.
    const monitored = resolveProtectedFolders(context.inboxes, state.settings);
    if (!monitored.some((candidate) => sameFolder(candidate, folder))) {
      return;
    }
    // The later of the two moments: protection as a whole, and this account when it was switched on again by hand.
    const protectionOnAt = Math.max(wholeSecond(state.settings.protectionOnAt ?? 0), wholeSecond(accountProtectedSince(state.settings, folder.accountId)));
    for await (const page of pages) {
      for (const message of page) {
        if (!state.settings.protection || !accountProtected(state.settings, folder.accountId)) {
          return;
        }
        if (message.date === 0 || message.date >= protectionOnAt || (await this.arrivedSince(message, protectionOnAt))) {
          await this.handleIncoming(context, message);
        }
      }
    }
  }

  /**
   * The Date header is written by the sender, so a message dated before a moment may
   * still have arrived at or after it. The newest Received header is written by the
   * receiving server and tells when the message really arrived.
   */
  private async arrivedSince(message: MessageInfo, time: number): Promise<boolean> {
    try {
      const received = (await this.deps.mail.headers(message.id))["received"]?.[0];
      return received !== undefined && receivedTime(received) >= time;
    } catch {
      return false;
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
        messageId: message.headerMessageId,
      };
    }
    // One write: the decision is logged and the message recorded as processed together.
    await state.log(entry, { kind: "in", id, now: now(), messageDate: message.date });
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
                messageId: message.headerMessageId,
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
      total: null,
    };
    onProgress({ ...progress });
    if (options.from === null && options.to === null && folders.length > 0) {
      // Without a date limit every message of the folders is read, so their sizes say how far the scan is.
      const counts = await Promise.all(folders.map((folder) => mail.messageCount(folder).catch(() => null)));
      if (counts.every((count): count is number => count !== null)) {
        progress.total = counts.reduce((sum, count) => sum + count, 0);
        onProgress({ ...progress });
      }
    }

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

    const outcome: CommandOutcome = { plan, moved: 0, failures: [], undo: { ...plan.undo, moves: [] } };
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
      const moving = group.filter((message) => !sameFolder(message.folder, target));
      for (let start = 0; start < moving.length; start += MOVE_BATCH) {
        const batch = moving.slice(start, start + MOVE_BATCH);
        // Noted before the move: where each message is now.
        const origins = batch.map((message) => ({ messageId: message.headerMessageId, from: message.folder }));
        try {
          await mail.move(
            batch.map((message) => message.id),
            target,
          );
          outcome.moved += batch.length;
          for (const origin of origins) {
            if (origin.from !== null) {
              outcome.undo.moves.push({ accountId, messageId: origin.messageId, from: { ...origin.from }, to: target });
            }
          }
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
   * Takes a command back: the entries exactly as they were, and every message it moved
   * to where it came from. A message the user has moved on since is left alone.
   */
  async undoCommand(undo: CommandUndo): Promise<CommandUndoOutcome> {
    const { state } = this.deps;
    const context = await this.context();
    for (const key of undo.remove) {
      state.removeEntry(key);
    }
    for (const entry of undo.restore) {
      state.restoreEntry(entry);
    }
    if (undo.remove.length > 0 || undo.restore.length > 0) {
      await state.saveEntries();
    }
    const outcome: CommandUndoOutcome = { moved: 0, notFound: 0, failures: [], back: [] };
    for (const move of undo.moves) {
      const result = await this.moveLogged(move.accountId, move.messageId, (folder) => sameFolder(folder, move.to), move.from);
      if (result.move === "moved") {
        outcome.moved += 1;
        outcome.back.push({ place: context.isJunk(move.from) ? "junk" : context.inboxes.some((inbox) => sameFolder(inbox, move.from)) ? "inbox" : "folder", folder: move.from });
      } else if (result.move === "failed") {
        outcome.failures.push(result.failure);
      } else {
        outcome.notFound += 1;
      }
    }
    if (state.whiteAdded) {
      await this.sweepScreening(context);
    }
    return outcome;
  }

  /** The sender the commands would act on for one message, and what the lists say about it now. */
  async describeSender(message: MessageInfo): Promise<SenderInfo> {
    const { state, mail } = this.deps;
    const context = await this.context();
    const effective = await new MessageReader(mail, message).effectiveSender(state);
    const sender = effective.sender;
    const where = { accountId: message.accountId, messageId: message.headerMessageId };
    if (sender === null) {
      return { address: "", via: effective.forwarder ?? "", own: false, domainTarget: null, deciding: null, ...where, unchanged: [], effects: {} };
    }
    const deciding = matchSender(state.entries, sender, message.accountId);
    const inJunk = context.isJunk(message.folder);
    const held = inJunk || (message.folder !== null && state.settings.screeningFolders.some((folder) => sameFolder(folder, message.folder)));
    const scope = state.newEntryScope(message.accountId);
    const unchanged = COMMANDS.filter((command) => {
      const list: ListName = command.startsWith("block") ? "black" : "white";
      // Block moves the message to Junk, trust moves it back from Junk or a screening folder.
      const moves = list === "black" ? !inJunk : held;
      if (moves || deciding?.list !== list) {
        return false;
      }
      if (!command.endsWith("domain")) {
        return true;
      }
      const target = commandTarget(state, command, sender);
      return state.entries.get(entryKey(target.kind, target.value, scope))?.list === list;
    });
    const effects: Partial<Record<CommandName, CommandPreview>> = {};
    for (const command of COMMANDS) {
      const effect = commandEffect(state, command, sender, message.accountId);
      effects[command] = {
        target: effect.target,
        change: effect.change,
        lifted: effect.lifted.map((entry) => ({ kind: entry.kind, value: entry.value })),
        moves: command.startsWith("block") ? !inJunk : held,
        kept: effect.kept === null ? null : { value: effect.kept.value, list: effect.kept.list },
      };
    }
    return {
      address: sender.address,
      via: effective.forwarder ?? "",
      own: context.own.has(sender.address),
      domainTarget: commandTarget(state, "block-domain", sender),
      deciding,
      ...where,
      unchanged,
      effects,
    };
  }

  /** The first copy of a message in an account, by its Message-ID header. Null when there is none. */
  async findMessage(accountId: string, messageId: string): Promise<MessageInfo | null> {
    if (messageId === "") {
      return null;
    }
    return (await this.deps.mail.findByMessageId(accountId, messageId))[0] ?? null;
  }

  /**
   * Moves the copies of a message that are in one of the expected folders. A message
   * the user has filed or deleted since is left alone and reported as not found.
   */
  private async moveLogged(
    accountId: string,
    messageId: string,
    isSource: (folder: FolderRef) => boolean,
    target: FolderRef | null,
  ): Promise<{ move: MoveResult; failure: string; from: FolderRef | null }> {
    const { mail } = this.deps;
    if (target === null) {
      return { move: "no-folder", failure: "", from: null };
    }
    let found: MessageInfo[] = [];
    try {
      found = messageId === "" ? [] : await mail.findByMessageId(accountId, messageId);
    } catch (error) {
      return { move: "failed", failure: errorText(error), from: null };
    }
    const sources = found.filter((message) => message.folder !== null && isSource(message.folder) && !sameFolder(message.folder, target));
    const from = sources[0]?.folder ?? null;
    if (from === null) {
      return { move: "not-found", failure: "", from: null };
    }
    try {
      await mail.move(
        sources.map((message) => message.id),
        target,
      );
      return { move: "moved", failure: "", from };
    } catch (error) {
      return { move: "failed", failure: errorText(error), from: null };
    }
  }

  /**
   * Undoes a logged decision from the log: the list change first, then the move.
   * Trust moves the message back to the Inbox from Junk or a screening folder, block
   * moves it to Junk from a monitored or a screening folder. When the message is no
   * longer there, the lists still change.
   */
  async runLogAction(entry: LogEntry, action: LogAction): Promise<LogActionOutcome> {
    const { state, now } = this.deps;
    const context = await this.context();
    const plan = applyLogAction(state, entry, action, context.own, now());
    if (plan.change !== "none") {
      await state.saveEntries();
    }

    const screening = new Set(state.settings.screeningFolders.map(folderKey));
    let moved: { move: MoveResult; failure: string; from: FolderRef | null } = { move: "none", failure: "", from: null };
    let target: FolderRef | null = null;
    if (expectsMove(entry, action)) {
      if (action === "trust") {
        target = context.inbox(entry.accountId);
        moved = await this.moveLogged(
          entry.accountId,
          entry.messageId,
          (folder) => context.isJunk(folder) || screening.has(folderKey(folder)),
          target,
        );
      } else {
        const monitored = new Set(resolveMonitoredFolders(context.inboxes, state.settings).map(folderKey));
        target = context.junk(entry.accountId);
        moved = await this.moveLogged(
          entry.accountId,
          entry.messageId,
          (folder) => monitored.has(folderKey(folder)) || screening.has(folderKey(folder)),
          target,
        );
      }
    }

    if (state.whiteAdded) {
      await this.sweepScreening(context);
    }
    return {
      list: plan.list,
      change: plan.change,
      target: plan.target,
      scope: plan.scope,
      behind: plan.behind === null ? null : { kind: plan.behind.kind, value: plan.behind.value },
      move: moved.move,
      failure: moved.failure,
      undo: {
        accountId: entry.accountId,
        messageId: entry.messageId,
        remove: plan.undo.remove,
        restore: plan.undo.restore,
        move: moved.move === "moved" && moved.from !== null && target !== null ? { from: moved.from, to: target } : null,
      },
    };
  }

  /** Takes a log action back: the entries exactly as they were, and the message to where it came from. */
  async undoLogAction(undo: LogActionUndo): Promise<{ move: MoveResult; failure: string }> {
    const { state } = this.deps;
    const context = await this.context();
    for (const key of undo.remove) {
      state.removeEntry(key);
    }
    for (const entry of undo.restore) {
      state.restoreEntry(entry);
    }
    if (undo.remove.length > 0 || undo.restore.length > 0) {
      await state.saveEntries();
    }
    let moved: { move: MoveResult; failure: string } = { move: "none", failure: "" };
    const move = undo.move;
    if (move !== null) {
      moved = await this.moveLogged(undo.accountId, undo.messageId, (folder) => sameFolder(folder, move.to), move.from);
    }
    if (state.whiteAdded) {
      await this.sweepScreening(context);
    }
    return { move: moved.move, failure: moved.failure };
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
        messageId: message.headerMessageId,
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
