import { describe, test, expect, afterEach, vi } from "vitest";
import { reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";

import reposApp from "@/api/repos";

afterEach(async () => {
  await reset();
});

const repos = () => env.REPOS.getByName("global");

// The LFS_SERVER service binding is stripped from the test wrangler (services: null),
// so drive the sub-app directly with a fabricated env: the real REPOS/REPO/GC bindings
// plus a stub lfs-server we can assert on / make fail.
function appEnv(lfs: Partial<Record<"blockRepo" | "unblockRepo" | "purgeRepo", unknown>> = {}) {
  const LFS_SERVER = {
    blockRepo: vi.fn(async () => {}),
    unblockRepo: vi.fn(async () => {}),
    purgeRepo: vi.fn(async () => {}),
    ...lfs,
  };
  return {
    env: {
      REPOS: env.REPOS,
      REPO: env.REPO,
      GC: env.GC,
      LFS_SERVER,
    } as unknown as CloudflareBindings,
    blockRepo: LFS_SERVER.blockRepo,
    unblockRepo: LFS_SERVER.unblockRepo,
  };
}
const post = (path: string, e: CloudflareBindings) => reposApp.request(path, { method: "POST" }, e);

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
      repos: Array<{
        repo: string;
        status: string;
        usage: Usage;
        willPurgeAt: string | null;
        lastAccessedAt: string | null;
      }>;
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
    const body = (await res.json()) as {
      repos: Array<{ repo: string; lastAccessedAt: string | null }>;
    };
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

  test("willArchiveAt = missingAt + GC_AUTO_ARCHIVE_DAYS for missing rows", async () => {
    await repos().upsert("alice", "gone");
    const missing = await repos().markMissing("alice", "gone");
    expect(missing?.missingAt).toBeTruthy();

    const res = await exports.default.fetch("http://localhost/api/repos");
    const body = (await res.json()) as {
      repos: Array<{ repo: string; missingAt: string | null; willArchiveAt: string | null }>;
    };
    const row = body.repos.find((r) => r.repo === "gone")!;
    expect(row.missingAt).toBe(missing!.missingAt);

    const archiveDays = env.GC.autoArchiveDays;
    const expected = new Date(row.missingAt!).getTime() + archiveDays * 24 * 60 * 60 * 1000;
    expect(new Date(row.willArchiveAt!).getTime()).toBe(expected);
  });

  test("willPurgeAt = archivedAt + GC_LIVE_STORAGE_RETENTION_DAYS (no cold storage) for blocked rows", async () => {
    await repos().upsert("alice", "gone");
    await repos().markMissing("alice", "gone");
    const archived = await repos().block("alice", "gone");
    expect(archived?.archivedAt).toBeTruthy();

    const res = await exports.default.fetch("http://localhost/api/repos");
    const body = (await res.json()) as {
      repos: Array<{ repo: string; archivedAt: string | null; willPurgeAt: string | null }>;
    };
    const row = body.repos.find((r) => r.repo === "gone")!;
    expect(row.archivedAt).toBe(archived!.archivedAt);

    const retentionDays = env.GC.liveStorageRetentionDays;
    const expected = new Date(row.archivedAt!).getTime() + retentionDays * 24 * 60 * 60 * 1000;
    expect(new Date(row.willPurgeAt!).getTime()).toBe(expected);
  });

  test("returns 401 without session on production host", async () => {
    const res = await exports.default.fetch("http://admin.example.com/api/repos");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });
});

describe("POST /api/repos/:owner/:repo/archive", () => {
  test("missing repo → blockRepo + archivedAt set, status stays missing", async () => {
    await repos().upsert("alice", "gone");
    await repos().markMissing("alice", "gone");
    const { env: e, blockRepo } = appEnv();

    const res = await post("/alice/gone/archive", e);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repo: { status: string; archivedAt: string | null } };
    expect(body.repo.status).toBe("missing"); // block doesn't change status
    expect(body.repo.archivedAt).toBeTruthy();
    expect(blockRepo).toHaveBeenCalledWith("alice", "gone");
    const row = await repos().get("alice", "gone");
    expect(row?.status).toBe("missing");
    expect(row?.archivedAt).toBeTruthy();
  });

  test("active repo → 409, no block", async () => {
    await repos().upsert("alice", "live");
    const { env: e, blockRepo } = appEnv();

    const res = await post("/alice/live/archive", e);
    expect(res.status).toBe(409);
    expect(blockRepo).not.toHaveBeenCalled();
    expect((await repos().get("alice", "live"))?.archivedAt).toBeNull();
  });

  test("already blocked → 409, no second block", async () => {
    await repos().upsert("alice", "gone");
    await repos().markMissing("alice", "gone");
    await repos().block("alice", "gone");
    const { env: e, blockRepo } = appEnv();

    const res = await post("/alice/gone/archive", e);
    expect(res.status).toBe(409);
    expect(blockRepo).not.toHaveBeenCalled();
  });

  test("unknown repo → 404", async () => {
    const { env: e } = appEnv();
    const res = await post("/nobody/nope/archive", e);
    expect(res.status).toBe(404);
  });

  test("blockRepo failure → 502, row stays unblocked (DO unchanged)", async () => {
    await repos().upsert("alice", "gone");
    await repos().markMissing("alice", "gone");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env: e } = appEnv({
      blockRepo: vi.fn(async () => {
        throw new Error("rpc down");
      }),
    });

    const res = await post("/alice/gone/archive", e);
    expect(res.status).toBe(502);
    const row = await repos().get("alice", "gone");
    expect(row?.status).toBe("missing");
    expect(row?.archivedAt).toBeNull();
    warn.mockRestore();
  });
});

describe("POST /api/repos/:owner/:repo/restore", () => {
  async function seedBlocked(owner: string, repo: string) {
    await repos().upsert(owner, repo);
    await repos().markMissing(owner, repo);
    await repos().block(owner, repo);
  }

  test("blocked repo → unblockRepo + archivedAt cleared, status unchanged (missing)", async () => {
    await seedBlocked("alice", "gone");
    const { env: e, unblockRepo } = appEnv();

    const res = await post("/alice/gone/restore", e);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repo: { status: string; archivedAt: string | null } };
    expect(body.repo.status).toBe("missing"); // presence untouched by restore
    expect(body.repo.archivedAt).toBeNull();
    expect(unblockRepo).toHaveBeenCalledWith("alice", "gone");
    const row = await repos().get("alice", "gone");
    expect(row?.status).toBe("missing");
    expect(row?.archivedAt).toBeNull();
  });

  test("not-blocked repo → 409, no unblock", async () => {
    await repos().upsert("alice", "live");
    const { env: e, unblockRepo } = appEnv();

    const res = await post("/alice/live/restore", e);
    expect(res.status).toBe(409);
    expect(unblockRepo).not.toHaveBeenCalled();
  });

  test("unknown repo → 404", async () => {
    const { env: e } = appEnv();
    expect((await post("/nobody/nope/restore", e)).status).toBe(404);
  });

  test("unblockRepo failure → 502, row stays blocked", async () => {
    await seedBlocked("alice", "gone");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env: e } = appEnv({
      unblockRepo: vi.fn(async () => {
        throw new Error("rpc down");
      }),
    });

    const res = await post("/alice/gone/restore", e);
    expect(res.status).toBe(502);
    expect((await repos().get("alice", "gone"))?.archivedAt).toBeTruthy();
    warn.mockRestore();
  });
});

describe("not-yet-implemented mutations → 501", () => {
  test.each([
    ["POST", "/alice/r/backup"],
    ["DELETE", "/alice/r/backup"],
    ["POST", "/alice/r/clear"],
    ["POST", "/alice/r/purge"],
  ])("%s %s", async (method, path) => {
    const { env: e } = appEnv();
    const res = await reposApp.request(path, { method }, e);
    expect(res.status).toBe(501);
  });
});
