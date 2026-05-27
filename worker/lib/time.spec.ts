import { test, expect } from "vitest";
import { isoNow } from "./time";

test("isoNow returns ISO string without milliseconds", () => {
  const result = isoNow();
  expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(result).not.toContain(".");
});
