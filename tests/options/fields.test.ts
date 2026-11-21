import { describe, expect, it } from "vitest";
import { mayRedraw, sameLabels, sameNumber } from "../../src/options/fields";

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
    expect(sameLabels(" From: ,, Od:", "From:, Od:")).toBe(true);
    expect(sameLabels("From:", "From:, Od:")).toBe(false);
  });
});
