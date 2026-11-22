import { describe, expect, it } from "vitest";
import { isRovingKey, rovingMove } from "../../src/options/roving";

describe("the arrow keys inside a table that is one tab stop", () => {
  // Five rows: two controls, one, none (a row that offers nothing), two, one.
  const counts = [2, 1, 0, 2, 1];

  it("moves Up and Down between the rows, past a row without a control, and stops at the ends", () => {
    expect(rovingMove("ArrowDown", { row: 0, control: 1 }, counts)).toEqual({ row: 1, control: 1 });
    expect(rovingMove("ArrowDown", { row: 1, control: 0 }, counts)).toEqual({ row: 3, control: 0 });
    expect(rovingMove("ArrowUp", { row: 3, control: 1 }, counts)).toEqual({ row: 1, control: 1 });
    expect(rovingMove("ArrowUp", { row: 0, control: 0 }, counts)).toBeNull();
    expect(rovingMove("ArrowDown", { row: 4, control: 0 }, counts)).toBeNull();
  });

  it("moves Left and Right between the controls of a row, and no further", () => {
    expect(rovingMove("ArrowRight", { row: 0, control: 0 }, counts)).toEqual({ row: 0, control: 1 });
    expect(rovingMove("ArrowRight", { row: 0, control: 1 }, counts)).toBeNull();
    expect(rovingMove("ArrowLeft", { row: 0, control: 1 }, counts)).toEqual({ row: 0, control: 0 });
    expect(rovingMove("ArrowLeft", { row: 0, control: 0 }, counts)).toBeNull();
    expect(rovingMove("ArrowRight", { row: 1, control: 0 }, counts)).toBeNull();
  });

  it("moves Home and End to the first and the last row that has a control", () => {
    expect(rovingMove("End", { row: 0, control: 1 }, counts)).toEqual({ row: 4, control: 1 });
    expect(rovingMove("Home", { row: 4, control: 0 }, counts)).toEqual({ row: 0, control: 0 });
    expect(rovingMove("Home", { row: 0, control: 0 }, counts)).toBeNull();
    expect(rovingMove("End", { row: 4, control: 0 }, counts)).toBeNull();
    expect(rovingMove("End", { row: 0, control: 0 }, [1, 0, 0])).toBeNull();
    expect(rovingMove("Home", { row: 2, control: 0 }, [0, 1, 1])).toEqual({ row: 1, control: 0 });
  });

  it("moves nowhere in a table without controls, and from a focused row without one it still finds the next", () => {
    expect(rovingMove("ArrowDown", { row: 0, control: 0 }, [0, 0])).toBeNull();
    expect(rovingMove("Home", { row: 1, control: 0 }, [0, 0])).toBeNull();
    expect(rovingMove("ArrowDown", { row: 2, control: 0 }, counts)).toEqual({ row: 3, control: 0 });
  });

  it("knows its keys, so that every other key keeps its meaning", () => {
    expect(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].every(isRovingKey)).toBe(true);
    expect(["Tab", "Enter", " ", "PageDown", "a"].some(isRovingKey)).toBe(false);
  });
});
