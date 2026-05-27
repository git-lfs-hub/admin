import { Hono } from "hono";
import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("@git-lfs-hub/auth", () => ({
  validateSession: vi.fn(),
  requireOrgRole: vi.fn(),
  SESSION_COOKIE: "gh_session_v2",
}));

import auth from "./auth";
import { validateSession, requireOrgRole } from "@git-lfs-hub/auth";

const mockValidateSession = vi.mocked(validateSession);
const mockRequireOrgRole = vi.mocked(requireOrgRole);

const ENV = {
  SESSION_SECRET: "a".repeat(64),
  GITHUB_ORG: "test-org",
};

function createApp() {
  const app = new Hono();
  app.use("*", auth as any);
  app.get("/test", (c) => c.json({ admin: (c as any).var.admin }));
  app.get("/api/test", (c) => c.json({ admin: (c as any).var.admin }));
  return app;
}

function req(path: string, host = "example.com") {
  return createApp().request(`http://${host}${path}`, {}, ENV);
}

describe("auth middleware", () => {
  beforeEach(() => {
    vi.resetAllMocks();
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

    test("does not call validateSession", async () => {
      await req("/test", "localhost");
      expect(mockValidateSession).not.toHaveBeenCalled();
    });
  });

  describe("production — no session", () => {
    test("API path returns 401 JSON", async () => {
      mockValidateSession.mockResolvedValue(null);
      const res = await req("/api/test");
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthenticated" });
    });

    test("non-API path redirects to OAuth", async () => {
      mockValidateSession.mockResolvedValue(null);
      const res = await req("/dashboard");
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "/login/oauth/authorize?state=%2Fdashboard",
      );
    });

    test("preserves query string in redirect", async () => {
      mockValidateSession.mockResolvedValue(null);
      const res = await req("/repos?page=2");
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "/login/oauth/authorize?state=%2Frepos%3Fpage%3D2",
      );
    });
  });

  describe("production — valid session", () => {
    test("sets admin to session username", async () => {
      mockValidateSession.mockResolvedValue({
        token: "ghu_t",
        username: "alice",
      });
      mockRequireOrgRole.mockResolvedValue(null);
      const res = await req("/test");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ admin: "alice" });
    });

    test("returns forbidden when org role check fails", async () => {
      mockValidateSession.mockResolvedValue({
        token: "ghu_t",
        username: "alice",
      });
      mockRequireOrgRole.mockResolvedValue(
        new Response("Forbidden", { status: 403 }),
      );
      const res = await req("/test");
      expect(res.status).toBe(403);
    });
  });
});
