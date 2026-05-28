import { describe, test, expect } from "vitest";
import { exports } from "cloudflare:workers";

describe("auth middleware (integration)", () => {
  test("localhost bypasses auth for any path", async () => {
    const res = await exports.default.fetch("http://localhost/api/me");
    expect(res.status).toBe(200);
  });

  test("non-API path without session redirects to OAuth", async () => {
    const res = await exports.default.fetch("http://admin.example.com/repos", {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    expect(location).toContain("/login/oauth/authorize");
    expect(location).toContain(encodeURIComponent("/repos"));
  });

  test("API path without session returns 401 JSON", async () => {
    const res = await exports.default.fetch("http://admin.example.com/api/repos");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });
});
