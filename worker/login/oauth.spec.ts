import { vi, describe, test, expect, afterEach } from "vitest";

vi.mock("@git-lfs-hub/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@git-lfs-hub/auth")>();
  return {
    ...actual,
    processOAuthCallback: vi.fn(),
    requireOrgRole: vi.fn(),
  };
});

import app from "./oauth";
import {
  processOAuthCallback,
  requireOrgRole,
  verifyState,
} from "@git-lfs-hub/auth";

const mockProcessOAuth = vi.mocked(processOAuthCallback);
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

  test("state round-trip: signed state embeds client_state", async () => {
    const signedState = await makeSignedState("/dashboard");
    const payload = await verifyState(signedState, SESSION_SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.client_state).toBe("/dashboard");
  });

  test("defaults client_state to /repos when state omitted", async () => {
    const res = await get("/authorize");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    const signedState = location.searchParams.get("state")!;
    const payload = await verifyState(signedState, SESSION_SECRET);
    expect(payload!.client_state).toBe("/repos");
  });
});

describe("GET /callback", () => {
  afterEach(() => vi.restoreAllMocks());

  test("returns 400 without code or state", async () => {
    const res = await get("/callback");
    expect(res.status).toBe(400);
  });

  test("returns 400 when state is missing", async () => {
    const res = await get("/callback?code=gh_code");
    expect(res.status).toBe(400);
  });

  test("returns 400 on invalid state (processOAuthCallback fails without statePayload)", async () => {
    mockProcessOAuth.mockResolvedValue({
      ok: false,
      error: "invalid_state",
    });
    const res = await get("/callback?code=gh_code&state=invalid");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid_state");
  });

  test("redirects with error when processOAuthCallback fails with statePayload", async () => {
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
      encrypted: "encrypted-session",
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
      encrypted: "encrypted-session-data",
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
    expect(cookie).toContain("gh_session_v2=encrypted-session-data");
  });
});
