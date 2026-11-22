import { describe, expect, it } from "vitest";
import { actsOnUnknownSenders, findProblems, protectionState, remedyFor, scanIsComplete, scanStep, unknownSenderEffects } from "../../src/core/problems";
import type { AccountFacts, ProblemInput } from "../../src/core/problems";
import { defaultSettings } from "../../src/core/settings";
import { accessPoint } from "../helpers/harness";

const NOW = 1_000_000;

function account(id: string, partial: Partial<AccountFacts> = {}): AccountFacts {
  return { id, inboxes: [{ accountId: id, path: "/INBOX" }], hasJunk: true, ...partial };
}

function input(partial: Partial<ProblemInput> = {}): ProblemInput {
  return {
    settings: defaultSettings(NOW),
    accessPoints: [],
    accounts: [account("work")],
    onlyOwnAddresses: false,
    now: NOW,
    ...partial,
  };
}

describe("a scan that ran to its end", () => {
  const scan = { running: false, cancelled: false, errors: [] as string[] };

  it("counts as complete, also when it found nobody", () => {
    expect(scanIsComplete(scan)).toBe(true);
  });

  it("does not count before it ran, while it runs, after Cancel or after an error", () => {
    expect(scanIsComplete(null)).toBe(false);
    expect(scanIsComplete({ ...scan, running: true })).toBe(false);
    expect(scanIsComplete({ ...scan, cancelled: true })).toBe(false);
    expect(scanIsComplete({ ...scan, errors: ["Sent: could not be read"] })).toBe(false);
  });
});

describe("setup step 1, the scan of sent mail", () => {
  const scan = { running: false, cancelled: false, errors: [] as string[], scanned: 12 };

  it("is to do until something was learned, and done when contacts were learned before this session", () => {
    expect(scanStep(null, false)).toBe("todo");
    expect(scanStep(null, true)).toBe("done");
  });

  it("is not done while a scan runs, also when the scan has learned entries already", () => {
    expect(scanStep({ ...scan, running: true }, true)).toBe("running");
    expect(scanStep({ ...scan, running: true }, false)).toBe("running");
  });

  it("is incomplete after Cancel and after a folder that could not be read", () => {
    expect(scanStep({ ...scan, cancelled: true }, true)).toBe("incomplete");
    expect(scanStep({ ...scan, errors: ["/Sent: could not be read"] }, true)).toBe("incomplete");
  });

  it("is done after a scan that ran to its end", () => {
    expect(scanStep(scan, true)).toBe("done");
  });

  it("is empty, not done, after a scan that found no sent mail at all", () => {
    expect(scanStep({ ...scan, scanned: 0 }, false)).toBe("empty");
    // Contacts learned from live sending count, also when the Sent folders are empty.
    expect(scanStep({ ...scan, scanned: 0 }, true)).toBe("done");
  });
});

describe("what to do about a service that needs attention", () => {
  it("asks for a key that is missing or was rejected", () => {
    expect(remedyFor(accessPoint({ apiKey: "", lastError: "" }), true)).toBe("key-missing");
    expect(remedyFor(accessPoint({ apiKey: "sk-wrong", lastError: "HTTP 401" }), true)).toBe("key-rejected");
  });

  it("asks for the permission first when this computer has not allowed the host", () => {
    expect(remedyFor(accessPoint({ apiKey: "" }), false)).toBe("permission");
  });

  it("asks a ChatGPT plan service to sign in, or says that the plan was refused", () => {
    const auth = { clientId: "c", subject: "s", email: "", idToken: "", accessToken: "a", refreshToken: "r", expiresAt: 0, earliestRefreshAt: 0, scopes: [] };
    expect(remedyFor(accessPoint({ type: "chatgpt", auth: null }), true)).toBe("sign-in");
    expect(remedyFor(accessPoint({ type: "chatgpt", auth: { ...auth, refreshToken: "" } }), true)).toBe("sign-in");
    expect(remedyFor(accessPoint({ type: "chatgpt", auth }), true)).toBe("plan-refused");
    expect(remedyFor(accessPoint({ type: "chatgpt", auth }), false)).toBe("permission");
  });
});

describe("problems that keep protection from working as set up", () => {
  it("finds none in a healthy setup", () => {
    expect(findProblems(input({ accessPoints: [accessPoint()] }))).toEqual([]);
    expect(findProblems(input())).toEqual([]);
  });

  it("warns when an AI service is on before anyone but the user is on the white list", () => {
    expect(findProblems(input({ accessPoints: [accessPoint()], onlyOwnAddresses: true }))).toEqual([{ kind: "before-scan", sent: true, moved: null }]);
    // Without a service that is switched on, nothing would be sent, and mail without a verdict stays where it is.
    expect(findProblems(input({ onlyOwnAddresses: true }))).toEqual([]);
    expect(findProblems(input({ accessPoints: [accessPoint({ enabled: false })], onlyOwnAddresses: true }))).toEqual([]);
  });

  it("warns as well when mail without a verdict is moved before anyone was learned, with no AI service at all", () => {
    const junk = { ...defaultSettings(NOW), noVerdictAction: "junk" as const };
    const screening = { ...defaultSettings(NOW), noVerdictAction: "screening" as const, screeningFolders: [{ accountId: "work", path: "/Screening" }] };
    // The README's own use without AI: every message from people the user writes to would be moved.
    expect(findProblems(input({ settings: junk, onlyOwnAddresses: true }))).toEqual([{ kind: "before-scan", sent: false, moved: "junk" }]);
    expect(findProblems(input({ settings: screening, onlyOwnAddresses: true }))).toEqual([{ kind: "before-scan", sent: false, moved: "screening" }]);
    expect(findProblems(input({ settings: junk, accessPoints: [accessPoint({ enabled: false })], onlyOwnAddresses: true }))).toEqual([{ kind: "before-scan", sent: false, moved: "junk" }]);
    // One cause is one problem, also when a service is on and all of them can fail: it names both things that happen.
    expect(findProblems(input({ settings: junk, accessPoints: [accessPoint()], onlyOwnAddresses: true }))).toEqual([{ kind: "before-scan", sent: true, moved: "junk" }]);
    // Once the sent mail is scanned, the choice is no problem.
    expect(findProblems(input({ settings: junk }))).toEqual([]);
    expect(findProblems(input({ settings: screening }))).toEqual([]);
  });

  it("knows what acts on unknown senders: a service that is switched on, and a choice that moves mail without a verdict", () => {
    const settings = defaultSettings(NOW);
    expect(unknownSenderEffects(settings, [])).toEqual({ sent: false, moved: null });
    expect(unknownSenderEffects(settings, [accessPoint({ enabled: false })])).toEqual({ sent: false, moved: null });
    expect(unknownSenderEffects(settings, [accessPoint({ enabled: false }), accessPoint({ id: "b" })])).toEqual({ sent: true, moved: null });
    expect(unknownSenderEffects({ noVerdictAction: "junk" }, [])).toEqual({ sent: false, moved: "junk" });
    expect(unknownSenderEffects({ noVerdictAction: "screening" }, [accessPoint()])).toEqual({ sent: true, moved: "screening" });
    expect(actsOnUnknownSenders({ sent: false, moved: null })).toBe(false);
    expect(actsOnUnknownSenders({ sent: true, moved: null })).toBe(true);
    expect(actsOnUnknownSenders({ sent: false, moved: "junk" })).toBe(true);
    expect(actsOnUnknownSenders({ sent: false, moved: "screening" })).toBe(true);
  });

  it("names every monitored account without a Junk folder, as one problem", () => {
    const accounts = [account("work", { hasJunk: false }), account("home"), account("feeds", { inboxes: [], hasJunk: false })];
    // An account without an Inbox and without added folders is not monitored at all.
    expect(findProblems(input({ accounts }))).toEqual([{ kind: "no-junk", accountIds: ["work"] }]);
    const settings = { ...defaultSettings(NOW), monitoredFoldersAdded: [{ accountId: "feeds", path: "/News" }] };
    // One cause is one problem, however many accounts share it.
    expect(findProblems(input({ accounts, settings }))).toEqual([{ kind: "no-junk", accountIds: ["work", "feeds"] }]);
  });

  it("names every service that is switched on and needs the user, with what to do about it", () => {
    const accessPoints = [
      accessPoint({ id: "a", needsAttention: true, lastError: "HTTP 401" }),
      accessPoint({ id: "b" }),
      accessPoint({ id: "c", needsAttention: true, enabled: false }),
    ];
    expect(findProblems(input({ accessPoints }))).toEqual([{ kind: "attention", remedy: "key-rejected", accessPointIds: ["a"] }]);
  });

  it("puts services with the same cause and remedy into one problem, and keeps different remedies apart", () => {
    const accessPoints = [
      accessPoint({ id: "a", needsAttention: true, lastError: "HTTP 401" }),
      accessPoint({ id: "b", needsAttention: true, apiKey: "", lastError: "" }),
      accessPoint({ id: "c", needsAttention: true, lastError: "HTTP 403" }),
      accessPoint({ id: "d", needsAttention: true, lastError: "HTTP 401" }),
    ];
    expect(findProblems(input({ accessPoints }))).toEqual([
      { kind: "attention", remedy: "key-rejected", accessPointIds: ["a", "c", "d"] },
      { kind: "attention", remedy: "key-missing", accessPointIds: ["b"] },
    ]);
    // A host this computer has not allowed needs the permission first, whatever else is wrong with the service.
    expect(findProblems(input({ accessPoints, hostGranted: (point) => point.id !== "d" }))).toEqual([
      { kind: "attention", remedy: "key-rejected", accessPointIds: ["a", "c"] },
      { kind: "attention", remedy: "key-missing", accessPointIds: ["b"] },
      { kind: "attention", remedy: "permission", accessPointIds: ["d"] },
    ]);
  });

  it("says that no service is working only when waiting can change that", () => {
    const paused = accessPoint({ id: "a", cooldownUntil: NOW + 60_000 });
    const rejected = accessPoint({ id: "b", needsAttention: true, lastError: "HTTP 401" });
    const attention = { kind: "attention", remedy: "key-rejected", accessPointIds: ["b"] };
    // One paused, one working: the next service takes over.
    expect(findProblems(input({ accessPoints: [paused, accessPoint({ id: "c" })] }))).toEqual([]);
    // All paused or waiting for the user.
    expect(findProblems(input({ accessPoints: [paused, rejected] }))).toEqual([attention, { kind: "ai-down" }]);
    // Only services that need the user: their own warnings say all there is to say.
    expect(findProblems(input({ accessPoints: [rejected] }))).toEqual([attention]);
    // The pause is over.
    expect(findProblems(input({ accessPoints: [paused], now: NOW + 60_000 }))).toEqual([]);
  });

  it("names monitored accounts without a screening folder when mail without a verdict goes there", () => {
    const accounts = [account("work"), account("home"), account("club")];
    const screening = { ...defaultSettings(NOW), noVerdictAction: "screening" as const, screeningFolders: [{ accountId: "work", path: "/Screening" }] };
    expect(findProblems(input({ accounts, settings: screening }))).toEqual([{ kind: "no-screening", accountIds: ["home", "club"] }]);
    // With another setting for such mail, a missing screening folder does not matter.
    expect(findProblems(input({ accounts, settings: { ...screening, noVerdictAction: "leave" } }))).toEqual([]);
  });

  it("lists the problems in the order the settings page shows them", () => {
    const settings = { ...defaultSettings(NOW), noVerdictAction: "screening" as const };
    const problems = findProblems(
      input({
        settings,
        accounts: [account("work", { hasJunk: false })],
        accessPoints: [accessPoint({ id: "a", needsAttention: true }), accessPoint({ id: "b", cooldownUntil: NOW + 1 })],
        onlyOwnAddresses: true,
      }),
    );
    expect(problems.map((problem) => problem.kind)).toEqual(["before-scan", "no-junk", "attention", "ai-down", "no-screening"]);
  });
});

describe("the state of protection", () => {
  const facts = { invalid: false, accounts: 1, protection: false, observation: false, problems: 0, waiting: false };

  it("is off after installation and on once protection is switched on", () => {
    expect(protectionState(facts)).toBe("off");
    expect(protectionState({ ...facts, protection: true })).toBe("on");
  });

  it("shows one state at a time, the most important first", () => {
    const everything = { invalid: true, accounts: 0, protection: true, observation: true, problems: 2, waiting: true };
    expect(protectionState(everything)).toBe("invalid");
    expect(protectionState({ ...everything, invalid: false })).toBe("no-account");
    expect(protectionState({ ...everything, invalid: false, accounts: 2 })).toBe("problems");
    expect(protectionState({ ...everything, invalid: false, accounts: 2, problems: 0 })).toBe("observing");
    expect(protectionState({ ...everything, invalid: false, accounts: 2, problems: 0, observation: false })).toBe("on");
  });

  it("says that protection waits for the scan only while it is off", () => {
    expect(protectionState({ ...facts, waiting: true })).toBe("waiting");
    expect(protectionState({ ...facts, waiting: true, protection: true })).toBe("on");
  });

  it("counts problems only while protection is on, and observation only then", () => {
    expect(protectionState({ ...facts, problems: 3 })).toBe("off");
    expect(protectionState({ ...facts, observation: true })).toBe("off");
  });
});
