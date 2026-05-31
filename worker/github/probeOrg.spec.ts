import { test, expect, vi, beforeEach, describe } from "vitest";
import { GithubOrgApi } from "@git-lfs-hub/lib/github";
import { probeOrg } from "@/github/probeOrg";

function orgApi(org = "alice") {
  return new GithubOrgApi("t", org);
}

function repoResponse(rows: { owner: string; name: string }[], link?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (link) headers.link = link;
  return new Response(
    JSON.stringify(rows.map((r) => ({ name: r.name, owner: { login: r.owner } }))),
    { status: 200, headers },
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("probeOrg — success", () => {
  test("200 with rows → active, lowercased key set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        repoResponse([
          { owner: "Alice", name: "Foo" },
          { owner: "alice", name: "bar" },
        ]),
      ),
    );
    const r = await probeOrg(orgApi("alice"));
    expect(r.status).toBe("active");
    expect(r.activeRepos).toEqual(new Set(["alice/foo", "alice/bar"]));
  });

  test("walks pages via Link rel=next", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        repoResponse(
          [{ owner: "a", name: "1" }],
          '<https://api.github.com/organizations/1/repos?page=2&per_page=100&type=all>; rel="next"',
        ),
      )
      .mockResolvedValueOnce(repoResponse([{ owner: "a", name: "2" }]));
    vi.stubGlobal("fetch", fetchMock);
    const r = await probeOrg(orgApi("a"));
    expect(r.status).toBe("active");
    expect(r.activeRepos).toEqual(new Set(["a/1", "a/2"]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("probeOrg — listing failure modes", () => {
  test("403 → forbidden", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 403 })));
    expect((await probeOrg(orgApi("a"))).status).toBe("forbidden");
  });

  test("404 → missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
    expect((await probeOrg(orgApi("a"))).status).toBe("missing");
  });

  test("5xx → transient_error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 502 })));
    expect((await probeOrg(orgApi("a"))).status).toBe("transient_error");
  });

  test("network reject → transient_error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    expect((await probeOrg(orgApi("a"))).status).toBe("transient_error");
  });

  test("200 empty array → transient_error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(repoResponse([])));
    expect((await probeOrg(orgApi("a"))).status).toBe("transient_error");
  });

  test("error message does not include token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 500 })));
    const r = await probeOrg(orgApi("x"));
    expect(r.error).not.toMatch(/Bearer/i);
    expect(r.error).not.toMatch(/\bt\b/);
  });
});
