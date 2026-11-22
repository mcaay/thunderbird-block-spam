import { afterEach, describe, expect, it, vi } from "vitest";

/** Loads the texts against messages that read as their own names, with the substitutions in brackets. */
async function texts() {
  vi.resetModules();
  vi.stubGlobal("browser", {
    i18n: {
      getMessage: (name: string, substitutions: string[] = []) => (name === "localeCode" ? "en" : substitutions.length === 0 ? name : `${name}(${substitutions.join(", ")})`),
    },
  });
  return import("../../src/tb/stateText");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("what happens to mail from existing contacts while the sent mail is not scanned", () => {
  it("names the consequence that applies: sent to the AI service, moved, or both", async () => {
    const { beforeScanText } = await texts();
    expect(beforeScanText({ sent: true, moved: null }, true)).toBe("warnAiBeforeScanOn");
    expect(beforeScanText({ sent: false, moved: "junk" }, true)).toBe("warnBeforeScanMovedOn(whereJunk)");
    expect(beforeScanText({ sent: false, moved: "screening" }, true)).toBe("warnBeforeScanMovedOn(whereScreening)");
    expect(beforeScanText({ sent: true, moved: "junk" }, true)).toBe("warnAiBeforeScanOn warnBeforeScanAlsoMovedOn(whereJunk)");
    expect(beforeScanText({ sent: true, moved: "screening" }, true)).toBe("warnAiBeforeScanOn warnBeforeScanAlsoMovedOn(whereScreening)");
    expect(beforeScanText({ sent: false, moved: null }, true)).toBe("");
  });

  it("says that it would happen while protection is off", async () => {
    const { beforeScanText } = await texts();
    expect(beforeScanText({ sent: true, moved: null }, false)).toBe("warnAiBeforeScan");
    expect(beforeScanText({ sent: false, moved: "junk" }, false)).toBe("warnBeforeScanMoved(whereJunk)");
    expect(beforeScanText({ sent: true, moved: "screening" }, false)).toBe("warnAiBeforeScan warnBeforeScanAlsoMoved(whereScreening)");
  });

  it("gives the question before protection is switched on the same variants, also while a scan runs", async () => {
    const { scanFirstReason, scanWaitReason } = await texts();
    expect(scanFirstReason({ sent: true, moved: null })).toBe("warnAiBeforeScan");
    expect(scanFirstReason({ sent: false, moved: "junk" })).toBe("scanFirstMoved(whereJunk)");
    expect(scanFirstReason({ sent: false, moved: "screening" })).toBe("scanFirstMoved(whereScreening)");
    expect(scanFirstReason({ sent: true, moved: "junk" })).toBe("warnAiBeforeScan warnBeforeScanAlsoMoved(whereJunk)");
    expect(scanWaitReason({ sent: true, moved: null })).toBe("scanWaitText");
    expect(scanWaitReason({ sent: false, moved: "screening" })).toBe("scanWaitMovedText(whereScreening)");
    expect(scanWaitReason({ sent: true, moved: "junk" })).toBe("scanWaitBothText(whereJunk)");
  });
});

describe("what became of the choice to move mail without a verdict after the scan", () => {
  it("says where such mail goes now, or that nothing was changed and why", async () => {
    const { noVerdictOutcomeText } = await texts();
    expect(noVerdictOutcomeText({ kind: "on", at: 1, scanned: 5 }, "junk")).toBe("noVerdictWishOn(whereJunk)");
    expect(noVerdictOutcomeText({ kind: "on", at: 1, scanned: 0 }, "screening")).toBe("noVerdictWishOnEmpty(whereScreening)");
    expect(noVerdictOutcomeText({ kind: "cancelled", at: 1, scanned: 5 }, "junk")).toBe("noVerdictWishCancelled");
    expect(noVerdictOutcomeText({ kind: "errors", at: 1, scanned: 5 }, "junk")).toBe("noVerdictWishErrors");
  });

  it("does not announce the scan a second time after a sentence about protection or a service", async () => {
    const { noVerdictOutcomeText } = await texts();
    expect(noVerdictOutcomeText({ kind: "on", at: 1, scanned: 0 }, "junk", true)).toBe("noVerdictAlsoOn(whereJunk)");
    expect(noVerdictOutcomeText({ kind: "errors", at: 1, scanned: 5 }, "junk", true)).toBe("noVerdictAlsoNotOn");
  });
});
