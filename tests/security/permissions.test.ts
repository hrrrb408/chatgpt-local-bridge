import { describe, it, expect } from "vitest";
import { levelAllows, levelName } from "../../src/security/permissions.js";

describe("permissions gate", () => {
  it("allows when configured >= required", () => {
    expect(levelAllows(0, 0)).toBe(true);
    expect(levelAllows(1, 0)).toBe(true);
    expect(levelAllows(1, 1)).toBe(true);
    expect(levelAllows(2, 2)).toBe(true);
  });

  it("denies when configured < required", () => {
    expect(levelAllows(0, 1)).toBe(false);
    expect(levelAllows(0, 2)).toBe(false);
    expect(levelAllows(1, 2)).toBe(false);
  });

  it("names levels", () => {
    expect(levelName(0)).toBe("read-only");
    expect(levelName(1)).toBe("edit");
    expect(levelName(2)).toBe("full");
  });
});
