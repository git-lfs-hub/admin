import { describe, test, expect, afterEach } from "vitest";
import { reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";

afterEach(async () => {
  await reset();
});

const repos = () => env.REPOS.getByName("global");

type Usage = Record<string, { count: number; size: number }>;

describe("GET /api/repos", () => {
  test("returns empty array when no repos exist (localhost bypass)", async () => {
    const res = await exports.default.fetch("http://localhost/api/repos");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repos: [] });
  });

  test("returns all repos across statuses with zero object stats when empty", async () => {
    await repos().upsert("alice", "a");
    await repos().upsert("bob", "b");
    await repos().markMissing("bob", "b");

    const res = await exports.default.fetch("http://localhost/api/repos");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repos: Array<{ repo: string; status: string; usage: Usage; willPurgeAt: string | null; lastAccessedAt: string | null }>;
    };

    expect(body.repos).toHaveLength(2);
    const byRepo = Object.fromEntries(body.repos.map((r) => [r.repo, r]));
    expect(byRepo.a.status).toBe("active");
    expect(byRepo.b.status).toBe("missing");
    for (const r of body.repos) {
      expect(r.usage.present).toEqual({ count: 0, size: 0 });
      expect(r.willPurgeAt).toBeNull();
      expect(r.lastAccessedAt).toBeNull();
    }
  });

  test("returns lastAccessedAt from the index", async () => {
    await repos().upsert("alice", "a");
    const row = await env.REPO.getByName("alice/a").recordObject("oid", 10, "download");

    const res = await exports.default.fetch("http://localhost/api/repos");
    const body = (await res.json()) as { repos: Array<{ repo: string; lastAccessedAt: string | null }> };
    expect(body.repos.find((r) => r.repo === "a")!.lastAccessedAt).toBe(row.lastAccessed);
  });

  test("returns the index usage breakdown by status", async () => {
    await repos().upsert("alice", "a");
    await env.REPO.getByName("alice/a").recordObject("oid1", 10, "download"); // present
    await env.REPO.getByName("alice/a").recordObject("oid2", 5, "verify"); // present
    await env.REPO.getByName("alice/a").recordObject("oid3", 7, "upload"); // pending
    await env.REPO.getByName("bob/other").recordObject("oid", 1, "download");

    const res = await exports.default.fetch("http://localhost/api/repos");
    const body = (await res.json()) as { repos: Array<{ repo: string; usage: Usage }> };
    const row = body.repos.find((r) => r.repo === "a")!;
    expect(row.usage.present).toEqual({ count: 2, size: 15 });
    expect(row.usage.pending).toEqual({ count: 1, size: 7 });
  });

  test("resolves the index DO by name case, not lowercased identity", async () => {
    // lfs-server keys the index DO by the client's case; identity is lowercased.
    await repos().upsert("Alice", "Repo");
    await env.REPO.getByName("Alice/Repo").recordObject("oid1", 7, "download");
    await env.REPO.getByName("Alice/Repo").recordObject("oid2", 3, "download");

    const res = await exports.default.fetch("http://localhost/api/repos");
    const body = (await res.json()) as { repos: Array<{ repo: string; usage: Usage }> };
    const row = body.repos.find((r) => r.repo === "repo")!;
    expect(row.usage.present).toEqual({ count: 2, size: 10 });
  });

  test("willPurgeAt = deletedAt + GC_PURGE_GRACE_DAYS for deleted rows", async () => {
    await repos().upsert("alice", "gone");
    await repos().markMissing("alice", "gone");
    const deleted = await repos().markDeleted("alice", "gone");
    expect(deleted?.deletedAt).toBeTruthy();

    const res = await exports.default.fetch("http://localhost/api/repos");
    const body = (await res.json()) as {
      repos: Array<{ repo: string; deletedAt: string | null; willPurgeAt: string | null }>;
    };
    const row = body.repos.find((r) => r.repo === "gone")!;
    expect(row.deletedAt).toBe(deleted!.deletedAt);

    const graceDays = Number(env.GC_PURGE_GRACE_DAYS);
    const expected = new Date(row.deletedAt!).getTime() + graceDays * 24 * 60 * 60 * 1000;
    expect(new Date(row.willPurgeAt!).getTime()).toBe(expected);
  });

  test("returns 401 without session on production host", async () => {
    const res = await exports.default.fetch("http://admin.example.com/api/repos");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });
});
