import { vi, describe, test, expect, afterEach } from "vitest";

vi.mock("@git-lfs-hub/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@git-lfs-hub/lib/auth")>();
  return {
    ...actual,
    oauthCallback: vi.fn(),
    requireOrgRole: vi.fn(),
  };
});

import app from "@/login/oauth";
import {
  oauthCallback,
  requireOrgRole,
} from "@git-lfs-hub/lib/auth";

const mockProcessOAuth = vi.mocked(oauthCallback);
const mockRequireOrgRole = vi.mocked(requireOrgRole);

const SESSION_SECRET = "a".repeat(64);
const ENV = {
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  GITHUB_ORG: "test-org",
  SESSION_SECRET,
};

function get(path: string) {
  return app.request(path, {}, ENV);
}

async function makeSignedState(returnTo = "/repos") {
  const res = await get(`/authorize?state=${encodeURIComponent(returnTo)}`);
  const location = new URL(res.headers.get("Location")!);
  return location.searchParams.get("state")!;
}

describe("GET /authorize", () => {
  test("redirects to GitHub with client_id and scope", async () => {
    const res = await get("/authorize?state=/repos");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(location.searchParams.get("client_id")).toBe("test-client-id");
    expect(location.searchParams.get("scope")).toBe("read:org");
  });

});

describe("GET /callback", () => {
  afterEach(() => vi.restoreAllMocks());

  test("returns 400 without code or state", async () => {
    mockProcessOAuth.mockResolvedValue({ ok: false, error: "invalid_state" });
    const res = await get("/callback");
    expect(res.status).toBe(400);
  });

  test("returns 400 when state is missing", async () => {
    mockProcessOAuth.mockResolvedValue({ ok: false, error: "invalid_state" });
    const res = await get("/callback?code=gh_code");
    expect(res.status).toBe(400);
  });

  test("returns 400 on invalid state (oauthCallback fails without statePayload)", async () => {
    mockProcessOAuth.mockResolvedValue({
      ok: false,
      error: "invalid_state",
    });
    const res = await get("/callback?code=gh_code&state=invalid");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid_state");
  });

  test("redirects with error when oauthCallback fails with statePayload", async () => {
    const signedState = await makeSignedState("/repos");
    mockProcessOAuth.mockResolvedValue({
      ok: false,
      error: "bad_verification_code",
      statePayload: {
        redirect_uri: "http://localhost/login/oauth/authorize",
        client_state: "/repos",
        scopes: "read:org",
      },
    });
    const res = await get(
      `/callback?code=bad&state=${encodeURIComponent(signedState)}`,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    expect(location).toContain("error=bad_verification_code");
  });

  test("returns 403 when requireOrgRole rejects", async () => {
    const signedState = await makeSignedState();
    mockProcessOAuth.mockResolvedValue({
      ok: true,
      tokenPayload: { token: "ghu_tok" },
      statePayload: {
        redirect_uri: "http://localhost/login/oauth/authorize",
        client_state: "/repos",
        scopes: "read:org",
      },
    });
    mockRequireOrgRole.mockResolvedValue(
      new Response("Forbidden: org admin required", { status: 403 }),
    );
    const res = await get(
      `/callback?code=gh_code&state=${encodeURIComponent(signedState)}`,
    );
    expect(res.status).toBe(403);
  });

  test("sets session cookie and redirects to client_state on success", async () => {
    const signedState = await makeSignedState("/dashboard");
    mockProcessOAuth.mockResolvedValue({
      ok: true,
      tokenPayload: { token: "ghu_tok" },
      statePayload: {
        redirect_uri: "http://localhost/login/oauth/authorize",
        client_state: "/dashboard",
        scopes: "read:org",
      },
    });
    mockRequireOrgRole.mockResolvedValue(null);

    const res = await get(
      `/callback?code=gh_code&state=${encodeURIComponent(signedState)}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/^gh_session_v2=[^;]+/);
  });
});
