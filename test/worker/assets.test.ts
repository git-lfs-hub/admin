import { describe, test, expect } from "vitest";
import { exports } from "cloudflare:workers";

describe("ASSETS fallback", () => {
  test("non-api path on localhost serves static asset", async () => {
    const res = await exports.default.fetch("http://localhost/some/spa/route");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("stub");
  });
});
