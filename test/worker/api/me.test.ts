import { describe, test, expect } from "vitest";
import { SELF } from "cloudflare:test";

describe("GET /api/me", () => {
  test("returns admin username on localhost (dev bypass)", async () => {
    const res = await SELF.fetch("http://localhost/api/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ admin: "dev" });
  });

  test("returns 401 without session cookie on production host", async () => {
    const res = await SELF.fetch("http://admin.example.com/api/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });
});
