import { describe, test, expect } from "vitest";
import { exports } from "cloudflare:workers";

describe("GET /login/oauth/authorize", () => {
  test("redirects to GitHub with correct params", async () => {
    const res = await exports.default.fetch(
      "http://localhost/login/oauth/authorize?state=/repos",
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    expect(location).toContain("github.com/login/oauth/authorize");
    expect(location).toContain("client_id=test-client-id");
    expect(location).toContain("scope=read%3Aorg");
  });
});

describe("GET /login/oauth/callback", () => {
  test("returns 400 without code or state", async () => {
    const res = await exports.default.fetch("http://localhost/login/oauth/callback");
    expect(res.status).toBe(400);
  });

  test("returns 400 with invalid state", async () => {
    const res = await exports.default.fetch(
      "http://localhost/login/oauth/callback?code=fake&state=invalid",
    );
    expect(res.status).toBe(400);
  });
});
