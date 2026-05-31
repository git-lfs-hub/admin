import { test, expect, vi, beforeEach, describe } from "vitest";
import { GithubError, GithubOrgApi } from "@git-lfs-hub/lib/github";
import { probeOrg } from "@/github/probeOrg";

function mkOrgApi(org = "alice") {
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
    const r = await probeOrg(mkOrgApi("alice"));
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
    const r = await probeOrg(mkOrgApi("a"));
    expect(r.status).toBe("active");
    expect(r.activeRepos).toEqual(new Set(["a/1", "a/2"]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("probeOrg — listing failure propagates (caller classifies)", () => {
  test("403 → throws GithubError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 403 })));
    await expect(probeOrg(mkOrgApi("a"))).rejects.toBeInstanceOf(GithubError);
  });

  test("404 → throws GithubError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
    await expect(probeOrg(mkOrgApi("a"))).rejects.toBeInstanceOf(GithubError);
  });

  test("5xx → throws GithubError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 502 })));
    await expect(probeOrg(mkOrgApi("a"))).rejects.toBeInstanceOf(GithubError);
  });

  test("network reject → propagates as GithubError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    await expect(probeOrg(mkOrgApi("a"))).rejects.toBeInstanceOf(GithubError);
  });

  test("200 empty array → transient_error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(repoResponse([])));
    expect((await probeOrg(mkOrgApi("a"))).status).toBe("transient_error");
  });
});
