// Shared data types. Nothing in src/core imports a Thunderbird API.

export type ListName = "white" | "black";
export type EntryKind = "address" | "domain";
export type EntrySource = "identity" | "sent" | "scan" | "ai" | "manual";

/** "all", or the id of the account an entry is limited to. */
export type Scope = string;
export const SCOPE_ALL = "all";

export interface Entry {
  list: ListName;
  kind: EntryKind;
  /** Normalized address, or registrable domain. */
  value: string;
  scope: Scope;
  source: EntrySource;
  addedAt: number;
}

/** A parsed, normalized sender or recipient. */
export interface Sender {
  /** local@host, lowercased, host in ASCII. */
  address: string;
  /** The part after "@". */
  host: string;
  /** Registrable domain of the host, or the host itself when it has none. */
  domain: string;
}

export interface Target {
  kind: EntryKind;
  value: string;
}

/** A folder is identified by its account and path. Folder ids are only stable within a session. */
export interface FolderRef {
  accountId: string;
  path: string;
}

export type NewEntryScope = "shared" | "account";
export type NoVerdictAction = "leave" | "junk" | "screening";

export interface Settings {
  schemaVersion: number;
  installedAt: number;
  protection: boolean;
  /** When protection was last switched on. Null while it has never been on. */
  protectionOnAt: number | null;
  observation: boolean;
  newEntryScope: NewEntryScope;
  noVerdictAction: NoVerdictAction;
  /** Domain shortcuts use the smart target instead of always the registrable domain. */
  smart: boolean;
  /**
   * The check every 5 minutes. It is there for mail that another device handled first. Switched off, mail is
   * checked when it arrives and when Thunderbird starts.
   */
  periodicCheck: boolean;
  cutoff: number;
  prompt: string;
  publicDomainsAdded: string[];
  publicDomainsRemoved: string[];
  forwardingMailboxes: string[];
  forwardLabels: string[];
  sentFoldersAdded: FolderRef[];
  sentFoldersRemoved: FolderRef[];
  monitoredFoldersAdded: FolderRef[];
  /**
   * The accounts whose protection the user switched by hand, at most one entry per account.
   * An account without an entry is protected, so a new account is protected from the start.
   */
  accountSwitches: AccountSwitch[];
  /** At most one screening folder per account. */
  screeningFolders: FolderRef[];
  /** The first-sign-in confirmation for ChatGPT plan use was shown. */
  chatgptWelcomeShown: boolean;
}

/** The protection of one account, switched by hand on the settings page. */
export interface AccountSwitch {
  accountId: string;
  /** False: the new mail of this account is never checked, sent to an AI service or moved. */
  on: boolean;
  /** When it was switched (epoch milliseconds). Mail that arrived before an account was switched on again is never handled. */
  at: number;
}

export type AccessPointType = "systemone" | "openai-decisions" | "openai-chat" | "anthropic" | "chatgpt";

/** Credentials of one ChatGPT plan sign-in. */
export interface ChatGptAuth {
  clientId: string;
  subject: string;
  email: string;
  idToken: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Epoch milliseconds, 0 when the server gave none. */
  earliestRefreshAt: number;
  scopes: string[];
}

export interface AccessPoint {
  id: string;
  type: AccessPointType;
  name: string;
  enabled: boolean;
  /** Full endpoint for decision models, base URL for chat types. Fixed for provider-bound types. */
  endpoint: string;
  model: string;
  /** Secret. Empty when the endpoint needs none. */
  apiKey: string;
  /** Secret. Only for the chatgpt type. */
  auth: ChatGptAuth | null;
  /** Skipped until this time (epoch milliseconds). 0 when not cooling down. */
  cooldownUntil: number;
  /** Set after HTTP 401 or 403. Skipped until the user edits the access point. */
  needsAttention: boolean;
  /** Short description of the last failure, without secrets. */
  lastError: string;
}

export type Outcome =
  | "trusted" // white list match
  | "blocked" // black list match
  | "spam" // AI score above the cutoff
  | "passed" // AI score at or below the cutoff
  | "no-verdict" // unknown sender, no AI verdict
  | "released" // moved from a screening folder to the Inbox after whitelisting
  | "error"; // the message could not be judged

export type Action = "none" | "junk" | "screening" | "inbox";

export interface LogEntry {
  time: number;
  accountId: string;
  account: string;
  /** Effective sender. Empty when it could not be determined. */
  sender: string;
  /** Forwarding mailbox of a wrapped forward, otherwise empty. */
  via: string;
  subject: string;
  outcome: Outcome;
  /** What was done, or would have been done in observation mode. */
  action: Action;
  score: number | null;
  accessPoint: string;
  /** Machine-readable reason code, see REASONS in decision.ts. */
  reason: string;
  detail: string;
  observed: boolean;
  test: boolean;
  /**
   * Message-ID header of the message, without angle brackets. Empty when the message
   * has none, and for entries logged before this field existed: such entries offer no action.
   */
  messageId: string;
}

/** Message metadata supplied by the mail layer. */
export interface MessageInfo {
  /** Session-local message id. */
  id: number;
  accountId: string;
  folder: FolderRef | null;
  /** Message-ID header, without angle brackets. May be empty. */
  headerMessageId: string;
  /** Raw From header value. */
  author: string;
  recipients: string[];
  ccList: string[];
  bccList: string[];
  subject: string;
  /** Epoch milliseconds, 0 when unknown. */
  date: number;
  size: number;
}

export interface AccountInfo {
  id: string;
  name: string;
  /** Address of the default identity, normalized. Null when the account has no identity. */
  email: string | null;
}

export interface Identity {
  accountId: string;
  email: string;
}
