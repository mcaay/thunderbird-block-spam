import { describe, expect, it } from "vitest";
import { cutoffNumber, endOfLocalDay, mayRedraw, sameLabels, sameNumber } from "../../src/options/fields";

describe("the scan's inclusive end date", () => {
  it("includes the selected day's last millisecond and excludes the next midnight", () => {
    const end = endOfLocalDay(new Date(2026, 10, 15).getTime());
    expect(end).toBe(new Date(2026, 10, 15, 23, 59, 59, 999).getTime());
    expect(new Date(2026, 10, 16).getTime()).toBeGreaterThan(end);
  });

  it("follows calendar days at month and daylight-saving boundaries", () => {
    for (const start of [new Date(2026, 0, 31), new Date(2026, 2, 29), new Date(2026, 9, 25)]) {
      expect(new Date(endOfLocalDay(start.getTime())).toString()).toBe(
        new Date(start.getFullYear(), start.getMonth(), start.getDate(), 23, 59, 59, 999).toString(),
      );
    }
  });
});

describe("fields that show a stored setting", () => {
  it("are filled the first time and follow the stored value while nobody edits them", () => {
    expect(mayRedraw({ value: "", focused: false }, null, "0.85", sameNumber)).toBe(true);
    expect(mayRedraw({ value: "0.85", focused: false }, "0.85", "0.70", sameNumber)).toBe(true);
  });

  it("keep an unsaved edit, also after the focus has left them", () => {
    // The user typed 0.90 and pressed the mouse on Save: the focus is on the button.
    expect(mayRedraw({ value: "0.90", focused: false }, "0.85", "0.85", sameNumber)).toBe(false);
    expect(mayRedraw({ value: "From:, Von:", focused: false }, "From:, Od:, Nadawca:", "From:, Od:, Nadawca:", sameLabels)).toBe(false);
  });

  it("are never redrawn while they have the focus", () => {
    expect(mayRedraw({ value: "0.85", focused: true }, "0.85", "0.70", sameNumber)).toBe(false);
  });

  it("follow the stored value again once the edit was saved", () => {
    expect(mayRedraw({ value: "0.9", focused: false }, "0.85", "0.90", sameNumber)).toBe(true);
    expect(mayRedraw({ value: "From:,Von:", focused: false }, "From:", "From:, Von:", sameLabels)).toBe(true);
  });

  it("compare cutoffs as numbers and labels after trimming", () => {
    expect(sameNumber("0.9", "0.90")).toBe(true);
    expect(sameNumber("", "0.00")).toBe(false);
    // A comma is the decimal sign of many languages: the field shows the cutoff the way the page writes numbers.
    expect(sameNumber("0,9", "0.90")).toBe(true);
    expect(sameNumber("0,9", "0,90")).toBe(true);
    expect(sameNumber("0,9", "0,85")).toBe(false);
    expect(mayRedraw({ value: "0,9", focused: false }, "0,85", "0,90", sameNumber)).toBe(true);
    expect(sameLabels(" From: ,, Od:", "From:, Od:")).toBe(true);
    expect(sameLabels("From:", "From:, Od:")).toBe(false);
  });
});

describe("the value a screen reader is told for the cutoff field", () => {
  it("is the number the field holds, with a point or a comma as the decimal sign", () => {
    expect(cutoffNumber("0.85")).toBe(0.85);
    expect(cutoffNumber("0,85")).toBe(0.85);
    expect(cutoffNumber(" 1 ")).toBe(1);
    expect(cutoffNumber("0")).toBe(0);
  });

  it("is not claimed while the text is empty, no number or outside 0 to 1", () => {
    for (const text of ["", "  ", "abc", "0.8.5", "1.2", "-0.1"]) {
      expect(cutoffNumber(text), text).toBeNull();
    }
  });
});
