import { Hono } from "hono";
import { describe, test, expect, vi, beforeEach } from "vitest";

const { mockGetSessionCookie, mockAuthenticatedUsername, mockRequireOrgRole } = vi.hoisted(() => ({
  mockGetSessionCookie: vi.fn(),
  mockAuthenticatedUsername: vi.fn(),
  mockRequireOrgRole: vi.fn(),
}));

vi.mock("@git-lfs-hub/lib/github", async (orig) => ({
  ...(await orig<typeof import("@git-lfs-hub/lib/github")>()),
  GithubApi: class MockGithubApi {
    constructor(_token: string) {}
    authenticatedUsername = mockAuthenticatedUsername;
  },
}));

vi.mock("@git-lfs-hub/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@git-lfs-hub/lib/auth")>()),
  getSessionCookie: mockGetSessionCookie,
  requireOrgRole: mockRequireOrgRole,
}));

import auth from "@/middleware/auth";

const ENV = {
  SESSION_SECRET: "a".repeat(64),
  GITHUB_ORG: "test-org",
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_CLIENT_SECRET: "test-client-secret",
};

const COOKIE = { Cookie: "gh_session_v2=anything" };

function createApp() {
  const app = new Hono();
  app.use("*", auth as any);
  app.get("/test", (c) => c.json({ admin: (c as any).var.admin }));
  app.get("/api/test", (c) => c.json({ admin: (c as any).var.admin }));
  return app;
}

function req(path: string, host = "example.com", init: RequestInit = {}) {
  return createApp().request(
    `http://${host}${path}`,
    { ...init, headers: { ...COOKIE, ...(init.headers ?? {}) } },
    ENV,
  );
}

describe("auth middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionCookie.mockResolvedValue({ token: "ghu_ok" });
    mockAuthenticatedUsername.mockResolvedValue("alice");
    mockRequireOrgRole.mockResolvedValue(null);
  });

  describe("localhost bypass", () => {
    test('sets admin to "dev" for localhost', async () => {
      const res = await req("/test", "localhost");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ admin: "dev" });
    });

    test('sets admin to "dev" for 127.0.0.1', async () => {
      const res = await req("/test", "127.0.0.1");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ admin: "dev" });
    });

    test("does not call getSessionCookie", async () => {
      await req("/test", "localhost");
      expect(mockGetSessionCookie).not.toHaveBeenCalled();
    });
  });

  describe("production — no session", () => {
    test("API path returns 401 JSON", async () => {
      mockGetSessionCookie.mockResolvedValue(null);
      const res = await req("/api/test");
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthenticated" });
    });

    test("non-API path redirects to OAuth", async () => {
      mockGetSessionCookie.mockResolvedValue(null);
      const res = await req("/dashboard");
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "/login/oauth/authorize?state=%2Fdashboard",
      );
    });

    test("preserves query string in redirect", async () => {
      mockGetSessionCookie.mockResolvedValue(null);
      const res = await req("/repos?page=2");
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "/login/oauth/authorize?state=%2Frepos%3Fpage%3D2",
      );
    });

    test("invalid session → redirect", async () => {
      mockAuthenticatedUsername.mockResolvedValue(null);
      const res = await req("/dashboard");
      expect(res.status).toBe(302);
    });
  });

  describe("production — valid session", () => {
    test("sets admin to GitHub login", async () => {
      mockAuthenticatedUsername.mockResolvedValue("alice");
      const res = await req("/test");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ admin: "alice" });
    });

    test("returns forbidden when org role check fails", async () => {
      mockRequireOrgRole.mockResolvedValue(
        new Response("Forbidden", { status: 403 }),
      );
      const res = await req("/test");
      expect(res.status).toBe(403);
    });
  });
});
