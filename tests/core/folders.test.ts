import { describe, expect, it } from "vitest";
import {
  accountProtected,
  accountProtectedSince,
  chosenFolders,
  folderCandidates,
  mayJoin,
  refusedFolders,
  resolveMonitoredFolders,
  resolveProtectedFolders,
  screeningFolderPaths,
  withAccountSwitch,
} from "../../src/core/folders";
import type { FolderFacts } from "../../src/core/folders";
import { defaultSettings } from "../../src/core/settings";
import type { FolderRef, Settings } from "../../src/core/types";

const NOW = 1_000_000;
const ACCOUNT = "work";

function folder(path: string, ...specialUse: string[]): FolderFacts {
  return { accountId: ACCOUNT, path, specialUse };
}

const INBOX = folder("/INBOX", "inbox");
const SENT = folder("/Sent", "sent");
const JUNK = folder("/Junk", "junk");
const TRASH = folder("/Trash", "trash");
const DRAFTS = folder("/Drafts", "drafts");
const TEMPLATES = folder("/Templates", "templates");
const OUTBOX = folder("/Outbox", "outbox");
const ARCHIVE = folder("/Archive", "archives");
const NEWSLETTERS = folder("/Newsletters");
const SENT_PHONE = folder("/Sent from phone");
const SCREENING = folder("/Screening");
const ALL = [INBOX, SENT, JUNK, TRASH, DRAFTS, TEMPLATES, OUTBOX, ARCHIVE, NEWSLETTERS, SENT_PHONE, SCREENING];

const ref = (item: FolderRef): FolderRef => ({ accountId: item.accountId, path: item.path });
const paths = (folders: readonly FolderRef[]): string[] => folders.map((item) => item.path);

function settings(partial: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(NOW), ...partial };
}

function chosen(partial: Partial<Settings> = {}) {
  return chosenFolders([ref(SENT)], [ref(INBOX)], settings(partial));
}

describe("the folders a menu offers", () => {
  it("offers as a Sent folder only what can hold sent mail", () => {
    expect(paths(folderCandidates("sent", ALL, chosen()))).toEqual(["/Archive", "/Newsletters", "/Sent from phone", "/Screening"]);
  });

  it("offers for monitoring only folders that can receive new mail", () => {
    expect(paths(folderCandidates("monitored", ALL, chosen()))).toEqual(["/Archive", "/Newsletters", "/Sent from phone", "/Screening"]);
  });

  it("offers as the screening folder neither the Inbox, nor Sent, nor Junk or Trash", () => {
    expect(paths(folderCandidates("screening", ALL, chosen()))).toEqual(["/Archive", "/Newsletters", "/Sent from phone", "/Screening"]);
  });

  it("gives a folder one job at most: what is on one list is offered for no other", () => {
    const now = chosen({
      sentFoldersAdded: [ref(SENT_PHONE)],
      monitoredFoldersAdded: [ref(NEWSLETTERS)],
      screeningFolders: [ref(SCREENING)],
    });
    expect(paths(folderCandidates("sent", ALL, now))).toEqual(["/Archive"]);
    expect(paths(folderCandidates("monitored", ALL, now))).toEqual(["/Archive"]);
    expect(paths(folderCandidates("screening", ALL, now))).toEqual(["/Archive"]);
  });

  it("offers a Sent folder again that the user took off the list", () => {
    const now = chosen({ sentFoldersRemoved: [ref(SENT)] });
    expect(paths(folderCandidates("sent", ALL, now))).toContain("/Sent");
    // Its role in Thunderbird still rules it out everywhere else.
    expect(paths(folderCandidates("monitored", ALL, now))).not.toContain("/Sent");
    expect(paths(folderCandidates("screening", ALL, now))).not.toContain("/Sent");
  });

  it("keeps the folders of other accounts apart", () => {
    const other: FolderFacts = { accountId: "home", path: "/Newsletters", specialUse: [] };
    const now = chosen({ monitoredFoldersAdded: [ref(NEWSLETTERS)] });
    expect(mayJoin("screening", other, now)).toBe(true);
    expect(mayJoin("screening", NEWSLETTERS, now)).toBe(false);
  });

  it("can leave nothing to offer", () => {
    expect(folderCandidates("sent", [INBOX, SENT, JUNK, TRASH], chosen())).toEqual([]);
  });
});

describe("a change of the folder lists", () => {
  const before = settings({ sentFoldersAdded: [ref(INBOX)] });
  const check = (after: Settings, from: Settings = before): string[] => paths(refusedFolders(from, after, ALL, [ref(SENT)], [ref(INBOX)]));

  it("refuses a folder whose role rules it out", () => {
    expect(check(settings({ sentFoldersAdded: [ref(JUNK)] }), settings())).toEqual(["/Junk"]);
    expect(check(settings({ monitoredFoldersAdded: [ref(SENT)] }), settings())).toEqual(["/Sent"]);
    expect(check(settings({ screeningFolders: [ref(INBOX)] }), settings())).toEqual(["/INBOX"]);
  });

  it("refuses a folder that has another job already", () => {
    const from = settings({ monitoredFoldersAdded: [ref(NEWSLETTERS)] });
    expect(check({ ...from, screeningFolders: [ref(NEWSLETTERS)] }, from)).toEqual(["/Newsletters"]);
    expect(check({ ...from, sentFoldersAdded: [ref(NEWSLETTERS)] }, from)).toEqual(["/Newsletters"]);
  });

  it("accepts a folder that may join the list", () => {
    expect(check(settings({ sentFoldersAdded: [ref(SENT_PHONE)], monitoredFoldersAdded: [ref(NEWSLETTERS)], screeningFolders: [ref(SCREENING)] }), settings())).toEqual([]);
  });

  it("never refuses what was stored before: it stays listed until the user removes it", () => {
    // The Inbox is on the Sent list from an earlier version. Another folder is added next to it.
    expect(check({ ...before, sentFoldersAdded: [ref(INBOX), ref(SENT_PHONE)] })).toEqual([]);
    // Taking it off is always possible.
    expect(check({ ...before, sentFoldersAdded: [] })).toEqual([]);
  });

  it("judges a folder Thunderbird does not know only by the other lists", () => {
    const gone: FolderRef = { accountId: ACCOUNT, path: "/Gone" };
    expect(check(settings({ sentFoldersAdded: [gone] }), settings())).toEqual([]);
    const from = settings({ screeningFolders: [gone] });
    expect(check({ ...from, monitoredFoldersAdded: [gone] }, from)).toEqual(["/Gone"]);
  });
});

describe("the screening folder Block Spam creates", () => {
  it("is at the top of the account, or inside its Inbox", () => {
    expect(screeningFolderPaths("Screening", [ref(INBOX), { accountId: "home", path: "/Inbox" }], ACCOUNT)).toEqual(["/Screening", "/INBOX/Screening"]);
  });
});

describe("protection per account", () => {
  it("protects every account until the user switches one off", () => {
    expect(accountProtected(settings(), ACCOUNT)).toBe(true);
    const off = settings({ accountSwitches: withAccountSwitch([], ACCOUNT, false, 5) });
    expect(accountProtected(off, ACCOUNT)).toBe(false);
    expect(accountProtected(off, "home")).toBe(true);
    // The mail of an account that is switched off is not handled. The list the user edits still holds its folders.
    const inboxes = [ref(INBOX), { accountId: "home", path: "/Inbox" }];
    expect(resolveProtectedFolders(inboxes, off)).toEqual([{ accountId: "home", path: "/Inbox" }]);
    expect(resolveMonitoredFolders(inboxes, off)).toEqual(inboxes);
  });

  it("remembers when an account was switched on again, with one entry per account", () => {
    const off = withAccountSwitch([], ACCOUNT, false, 5);
    const on = withAccountSwitch(off, ACCOUNT, true, 9);
    expect(on).toEqual([{ accountId: ACCOUNT, on: true, at: 9 }]);
    expect(accountProtectedSince({ accountSwitches: off }, ACCOUNT)).toBe(0);
    expect(accountProtectedSince({ accountSwitches: on }, ACCOUNT)).toBe(9);
    expect(accountProtectedSince({ accountSwitches: on }, "home")).toBe(0);
  });
});
