import { describe, test, expect, afterEach } from "vitest";
import { reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";

afterEach(async () => {
  await reset();
});

const index = (key: string) => env.INDEX.get(env.INDEX.idFromName(key));

type Usage = Record<string, { count: number; size: number }>;

describe("GET /api/repos", () => {
  test("returns empty array when no repos exist (localhost bypass)", async () => {
    const res = await exports.default.fetch("http://localhost/api/repos");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repos: [] });
  });

  test("returns all repos across statuses with zero object stats when empty", async () => {
    const stub = env.REPOS.get(env.REPOS.idFromName("global"));
    await stub.upsert("alice", "a");
    await stub.upsert("bob", "b");
    await stub.markMissing("bob", "b");

    const res = await exports.default.fetch("http://localhost/api/repos");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repos: Array<{ repo: string; status: string; usage: Usage; willPurgeAt: string | null }>;
    };

    expect(body.repos).toHaveLength(2);
    const byRepo = Object.fromEntries(body.repos.map((r) => [r.repo, r]));
    expect(byRepo.a.status).toBe("active");
    expect(byRepo.b.status).toBe("missing");
    for (const r of body.repos) {
      expect(r.usage.present).toEqual({ count: 0, size: 0 });
      expect(r.willPurgeAt).toBeNull();
    }
  });

  test("returns the index usage breakdown by status", async () => {
    const stub = env.REPOS.get(env.REPOS.idFromName("global"));
    await stub.upsert("alice", "a");
    await index("alice/a").recordObject("oid1", 10, "download"); // present
    await index("alice/a").recordObject("oid2", 5, "verify"); // present
    await index("alice/a").recordObject("oid3", 7, "upload"); // pending
    await index("bob/other").recordObject("oid", 1, "download");

    const res = await exports.default.fetch("http://localhost/api/repos");
    const body = (await res.json()) as { repos: Array<{ repo: string; usage: Usage }> };
    const row = body.repos.find((r) => r.repo === "a")!;
    expect(row.usage.present).toEqual({ count: 2, size: 15 });
    expect(row.usage.pending).toEqual({ count: 1, size: 7 });
  });

  test("resolves the index DO by storage_prefix case, not lowercased identity", async () => {
    const stub = env.REPOS.get(env.REPOS.idFromName("global"));
    // lfs-server keys the index DO by the client's case; identity is lowercased.
    await stub.upsert("Alice", "Repo");
    await index("Alice/Repo").recordObject("oid1", 7, "download");
    await index("Alice/Repo").recordObject("oid2", 3, "download");

    const res = await exports.default.fetch("http://localhost/api/repos");
    const body = (await res.json()) as { repos: Array<{ repo: string; usage: Usage }> };
    const row = body.repos.find((r) => r.repo === "repo")!;
    expect(row.usage.present).toEqual({ count: 2, size: 10 });
  });

  test("willPurgeAt = deletedAt + GC_PURGE_GRACE_DAYS for deleted rows", async () => {
    const stub = env.REPOS.get(env.REPOS.idFromName("global"));
    await stub.upsert("alice", "gone");
    await stub.markMissing("alice", "gone");
    const deleted = await stub.markDeleted("alice", "gone");
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
