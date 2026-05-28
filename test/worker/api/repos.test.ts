import { describe, test, expect, afterEach } from "vitest";
import { reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";

afterEach(async () => {
  await reset();
});

describe("GET /api/repos", () => {
  test("returns empty array when no repos exist (localhost bypass)", async () => {
    const res = await exports.default.fetch("http://localhost/api/repos");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repos: [] });
  });

  test("returns all repos across statuses with null object stats", async () => {
    const stub = env.REPOS.get(env.REPOS.idFromName("global"));
    await stub.upsert("alice", "a");
    await stub.upsert("bob", "b");
    await stub.markMissing("bob", "b");

    const res = await exports.default.fetch("http://localhost/api/repos");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: Array<Record<string, unknown>> };

    expect(body.repos).toHaveLength(2);
    const byRepo = Object.fromEntries(body.repos.map((r) => [r.repo, r]));
    expect(byRepo.a.status).toBe("active");
    expect(byRepo.b.status).toBe("missing");
    for (const r of body.repos) {
      expect(r.objectCount).toBeNull();
      expect(r.totalSize).toBeNull();
      expect(r.willPurgeAt).toBeNull();
    }
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
