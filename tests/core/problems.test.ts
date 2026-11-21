import { describe, expect, it } from "vitest";
import { findProblems, remedyFor, scanIsComplete, scanStep } from "../../src/core/problems";
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
    expect(findProblems(input({ accessPoints: [accessPoint()], onlyOwnAddresses: true }))).toEqual([{ kind: "ai-before-scan" }]);
    // Without a service that is switched on, nothing would be sent.
    expect(findProblems(input({ onlyOwnAddresses: true }))).toEqual([]);
    expect(findProblems(input({ accessPoints: [accessPoint({ enabled: false })], onlyOwnAddresses: true }))).toEqual([]);
  });

  it("names every monitored account without a Junk folder", () => {
    const accounts = [account("work", { hasJunk: false }), account("home"), account("feeds", { inboxes: [], hasJunk: false })];
    // An account without an Inbox and without added folders is not monitored at all.
    expect(findProblems(input({ accounts }))).toEqual([{ kind: "no-junk", accountId: "work" }]);
    const settings = { ...defaultSettings(NOW), monitoredFoldersAdded: [{ accountId: "feeds", path: "/News" }] };
    expect(findProblems(input({ accounts, settings }))).toEqual([
      { kind: "no-junk", accountId: "work" },
      { kind: "no-junk", accountId: "feeds" },
    ]);
  });

  it("names every service that is switched on and needs the user", () => {
    const accessPoints = [
      accessPoint({ id: "a", needsAttention: true }),
      accessPoint({ id: "b" }),
      accessPoint({ id: "c", needsAttention: true, enabled: false }),
    ];
    expect(findProblems(input({ accessPoints }))).toEqual([{ kind: "attention", accessPointId: "a" }]);
  });

  it("says that no service is working only when waiting can change that", () => {
    const paused = accessPoint({ id: "a", cooldownUntil: NOW + 60_000 });
    const rejected = accessPoint({ id: "b", needsAttention: true });
    // One paused, one working: the next service takes over.
    expect(findProblems(input({ accessPoints: [paused, accessPoint({ id: "c" })] }))).toEqual([]);
    // All paused or waiting for the user.
    expect(findProblems(input({ accessPoints: [paused, rejected] }))).toEqual([{ kind: "attention", accessPointId: "b" }, { kind: "ai-down" }]);
    // Only services that need the user: their own warnings say all there is to say.
    expect(findProblems(input({ accessPoints: [rejected] }))).toEqual([{ kind: "attention", accessPointId: "b" }]);
    // The pause is over.
    expect(findProblems(input({ accessPoints: [paused], now: NOW + 60_000 }))).toEqual([]);
  });

  it("names monitored accounts without a screening folder when mail without a verdict goes there", () => {
    const accounts = [account("work"), account("home")];
    const screening = { ...defaultSettings(NOW), noVerdictAction: "screening" as const, screeningFolders: [{ accountId: "work", path: "/Screening" }] };
    expect(findProblems(input({ accounts, settings: screening }))).toEqual([{ kind: "no-screening", accountId: "home" }]);
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
    expect(problems.map((problem) => problem.kind)).toEqual(["ai-before-scan", "no-junk", "attention", "ai-down", "no-screening"]);
  });
});
