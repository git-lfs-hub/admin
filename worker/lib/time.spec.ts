import { test, expect } from "vitest";
import { isoNow, isoAddDays } from "./time";

test("nowIso returns ISO string without milliseconds", () => {
  const result = isoNow();
  expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(result).not.toContain(".");
});

test("addDaysIso advances by N days and strips milliseconds", () => {
  expect(isoAddDays("2026-01-01T00:00:00Z", 7)).toBe("2026-01-08T00:00:00Z");
});

test("addDaysIso handles month rollover", () => {
  expect(isoAddDays("2026-01-30T12:00:00Z", 3)).toBe("2026-02-02T12:00:00Z");
});

test("addDaysIso accepts zero and negative days", () => {
  expect(isoAddDays("2026-03-15T10:00:00Z", 0)).toBe("2026-03-15T10:00:00Z");
  expect(isoAddDays("2026-03-15T10:00:00Z", -5)).toBe("2026-03-10T10:00:00Z");
});
