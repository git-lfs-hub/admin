import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { describe, test, expect, afterEach } from "vitest";

afterEach(async () => {
  await reset();
});

const repos = () => env.REPOS.getByName("global");

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// ---------------------------------------------------------------------------
// upsert
// ---------------------------------------------------------------------------

describe("upsert", () => {
  test("inserts new row as active with timestamps", async () => {
    const row = await repos().upsert("alice", "repo");
    expect(row.owner).toBe("alice");
    expect(row.repo).toBe("repo");
    expect(row.status).toBe("active");
    expect(row.firstSeen).toMatch(ISO_RE);
    expect(row.updatedAt).toMatch(ISO_RE);
    expect(row.missingAt).toBeNull();
    expect(row.archivedAt).toBeNull();
    expect(row.purgedAt).toBeNull();
    expect(row.backedUpAt).toBeNull();
    expect(row.backupComplete).toBe(false);
    expect(row.clearedAt).toBeNull();
    expect(row.activeOp).toBeNull();
  });

  test("preserves firstSeen but updates updatedAt on second upsert", async () => {
    const a = await repos().upsert("alice", "repo");
    await new Promise((r) => setTimeout(r, 1100));
    const b = await repos().upsert("alice", "repo");
    expect(b.firstSeen).toBe(a.firstSeen);
    expect(b.updatedAt).not.toBe(a.updatedAt);
    expect(b.status).toBe("active");
  });

  test("does not reset status on existing row", async () => {
    await repos().upsert("alice", "repo");
    await repos().markMissing("alice", "repo");
    const row = await repos().upsert("alice", "repo");
    expect(row.status).toBe("missing");
  });

  test("normalizes owner/repo to lowercase on insert", async () => {
    const row = await repos().upsert("Alice", "MyRepo");
    expect(row.owner).toBe("alice");
    expect(row.repo).toBe("myrepo");
  });

  test("stores name in the original R2 case", async () => {
    const row = await repos().upsert("Alice", "MyRepo");
    expect(row.name).toBe("Alice/MyRepo");
  });

  test("keeps the original name when a later case differs", async () => {
    // R2 keys live under the case of the first upload; a later differently-cased
    // call (e.g. GitHub owner/repo case changed) must not clobber the real name.
    await repos().upsert("Alice", "MyRepo");
    const row = await repos().upsert("alice", "myrepo");
    expect(row.name).toBe("Alice/MyRepo");
  });

  test("mixed-case + lowercase calls hit the same row", async () => {
    const a = await repos().upsert("Alice", "Foo");
    await repos().markMissing("ALICE", "FOO");
    const b = await repos().get("alice", "foo");
    expect(b?.status).toBe("missing");
    expect(b?.firstSeen).toBe(a.firstSeen);
    expect((await repos().listAll()).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// get / listByStatus
// ---------------------------------------------------------------------------

describe("get", () => {
  test("returns row when present", async () => {
    await repos().upsert("alice", "repo");
    const row = await repos().get("alice", "repo");
    expect(row?.owner).toBe("alice");
  });

  test("returns null when absent", async () => {
    expect(await repos().get("nope", "nope")).toBeNull();
  });
});

describe("listByStatus", () => {
  test("returns only repos with matching status", async () => {
    await repos().upsert("alice", "a");
    await repos().upsert("alice", "b");
    await repos().upsert("bob", "c");
    await repos().markMissing("alice", "a");

    const active = await repos().listByStatus("active");
    const missing = await repos().listByStatus("missing");
    expect(active.map((r) => r.repo).sort()).toEqual(["b", "c"]);
    expect(missing.map((r) => r.repo)).toEqual(["a"]);
  });

  test("returns empty array when none match", async () => {
    expect(await repos().listByStatus("purged")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// transitions
// ---------------------------------------------------------------------------

describe("markMissing", () => {
  test("active → missing sets missing_at", async () => {
    await repos().upsert("alice", "repo");
    const row = await repos().markMissing("alice", "repo");
    expect(row?.status).toBe("missing");
    expect(row?.missingAt).toMatch(ISO_RE);
  });

  test("returns null when repo does not exist", async () => {
    expect(await repos().markMissing("nope", "nope")).toBeNull();
  });

  test("returns null when status is not active", async () => {
    await repos().upsert("alice", "repo");
    await repos().markMissing("alice", "repo");
    expect(await repos().markMissing("alice", "repo")).toBeNull();
  });
});

describe("markActive", () => {
  test("missing → active clears missing_at", async () => {
    await repos().upsert("alice", "repo");
    await repos().markMissing("alice", "repo");
    const row = await repos().markActive("alice", "repo");
    expect(row?.status).toBe("active");
    expect(row?.missingAt).toBeNull();
  });

  test("presence flip only — keeps archivedAt (block is a separate axis)", async () => {
    await repos().upsert("alice", "repo");
    await repos().markMissing("alice", "repo");
    await repos().block("alice", "repo");
    const row = await repos().markActive("alice", "repo");
    expect(row?.status).toBe("active");
    expect(row?.missingAt).toBeNull();
    expect(row?.archivedAt).not.toBeNull(); // still blocked
  });

  test("returns null when already active", async () => {
    await repos().upsert("alice", "repo");
    expect(await repos().markActive("alice", "repo")).toBeNull();
  });

  test("returns null when purged", async () => {
    await repos().upsert("alice", "repo");
    await repos().markMissing("alice", "repo");
    await repos().block("alice", "repo");
    await repos().markPurged("alice", "repo");
    expect(await repos().markActive("alice", "repo")).toBeNull();
  });

  test("returns null when repo does not exist", async () => {
    expect(await repos().markActive("nope", "nope")).toBeNull();
  });
});

describe("block", () => {
  test("sets archivedAt without changing status (missing stays missing)", async () => {
    await repos().upsert("alice", "repo");
    await repos().markMissing("alice", "repo");
    const row = await repos().block("alice", "repo");
    expect(row?.status).toBe("missing");
    expect(row?.archivedAt).toMatch(ISO_RE);
  });

  test("can block an active repo without changing status", async () => {
    await repos().upsert("alice", "repo");
    const row = await repos().block("alice", "repo");
    expect(row?.status).toBe("active");
    expect(row?.archivedAt).toMatch(ISO_RE);
  });

  test("returns null when already blocked", async () => {
    await repos().upsert("alice", "repo");
    await repos().block("alice", "repo");
    expect(await repos().block("alice", "repo")).toBeNull();
  });

  test("returns null when purged", async () => {
    await repos().upsert("alice", "repo");
    await repos().markMissing("alice", "repo");
    await repos().block("alice", "repo");
    await repos().markPurged("alice", "repo");
    expect(await repos().block("alice", "repo")).toBeNull();
  });

  test("returns null when repo does not exist", async () => {
    expect(await repos().block("nope", "nope")).toBeNull();
  });
});

describe("unblock", () => {
  test("clears archivedAt without changing status (missing stays missing)", async () => {
    await repos().upsert("alice", "repo");
    await repos().markMissing("alice", "repo");
    await repos().block("alice", "repo");
    const row = await repos().unblock("alice", "repo");
    expect(row?.status).toBe("missing");
    expect(row?.archivedAt).toBeNull();
  });

  test("returns null when not blocked", async () => {
    await repos().upsert("alice", "repo");
    await repos().markMissing("alice", "repo");
    expect(await repos().unblock("alice", "repo")).toBeNull();
  });

  test("returns null when repo does not exist", async () => {
    expect(await repos().unblock("nope", "nope")).toBeNull();
  });
});

describe("markPurged", () => {
  test("blocked → purged sets purged_at", async () => {
    await repos().upsert("alice", "repo");
    await repos().markMissing("alice", "repo");
    await repos().block("alice", "repo");
    const row = await repos().markPurged("alice", "repo");
    expect(row?.status).toBe("purged");
    expect(row?.purgedAt).toMatch(ISO_RE);
  });

  test("returns null when not blocked (archivedAt null)", async () => {
    await repos().upsert("alice", "repo");
    await repos().markMissing("alice", "repo");
    expect(await repos().markPurged("alice", "repo")).toBeNull();
  });

  test("returns null when repo does not exist", async () => {
    expect(await repos().markPurged("nope", "nope")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listOwners
// ---------------------------------------------------------------------------

describe("listOwners", () => {
  test("returns distinct lowercased owners across active|missing|blocked", async () => {
    await repos().upsert("Alice", "a");
    await repos().upsert("alice", "b");
    await repos().upsert("Bob", "c");
    await repos().upsert("Carol", "d");
    await repos().markMissing("Bob", "c");
    await repos().markMissing("Carol", "d");
    await repos().block("Carol", "d");
    const owners = (await repos().listOwners()).sort();
    expect(owners).toEqual(["alice", "bob", "carol"]);
  });

  test("excludes purged-only owners", async () => {
    await repos().upsert("alice", "a");
    await repos().markMissing("alice", "a");
    await repos().block("alice", "a");
    await repos().markPurged("alice", "a");
    expect(await repos().listOwners()).toEqual([]);
  });

  test("empty → []", async () => {
    expect(await repos().listOwners()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// recordReconciliation
// ---------------------------------------------------------------------------

function key(owner: string, repo: string) {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

describe("recordReconciliation", () => {
  test("active absent → missing; active present → no-op", async () => {
    await repos().upsert("alice", "a");
    await repos().upsert("alice", "b");
    const r = await repos().recordReconciliation({
      activeOrgs: new Set(["alice"]),
      activeRepos: new Set([key("alice", "a")]),
    });
    expect(r.missing.map((x) => x.repo)).toEqual(["b"]);
    expect(r.reappeared).toEqual([]);
    expect(r.blockedPresent).toEqual([]);
    expect((await repos().get("alice", "b"))?.status).toBe("missing");
    expect((await repos().get("alice", "a"))?.status).toBe("active");
  });

  test("missing present → reappeared (active, missing_at cleared)", async () => {
    await repos().upsert("alice", "a");
    await repos().markMissing("alice", "a");
    const r = await repos().recordReconciliation({
      activeOrgs: new Set(["alice"]),
      activeRepos: new Set([key("alice", "a")]),
    });
    expect(r.reappeared.map((x) => x.repo)).toEqual(["a"]);
    expect(r.blockedPresent).toEqual([]);
    const row = await repos().get("alice", "a");
    expect(row?.status).toBe("active");
    expect(row?.missingAt).toBeNull();
  });

  test("blocked + present → reappeared + blockedPresent; block NOT cleared by the DO", async () => {
    await repos().upsert("alice", "a");
    await repos().markMissing("alice", "a");
    await repos().block("alice", "a");
    const r = await repos().recordReconciliation({
      activeOrgs: new Set(["alice"]),
      activeRepos: new Set([key("alice", "a")]),
    });
    expect(r.reappeared.map((x) => x.repo)).toEqual(["a"]); // presence flipped
    expect(r.blockedPresent.map((x) => x.repo)).toEqual(["a"]); // surfaced for unblock
    const row = await repos().get("alice", "a");
    expect(row?.status).toBe("active");
    expect(row?.archivedAt).not.toBeNull(); // worker (RPC-gated) does the unblock, not the DO
  });

  test("purged untouched", async () => {
    await repos().upsert("alice", "a");
    await repos().markMissing("alice", "a");
    await repos().block("alice", "a");
    await repos().markPurged("alice", "a");
    const r = await repos().recordReconciliation({
      activeOrgs: new Set(["alice"]),
      activeRepos: new Set(),
    });
    expect(r.missing).toEqual([]);
    expect((await repos().get("alice", "a"))?.status).toBe("purged");
  });

  test("rows from non-active orgs untouched", async () => {
    await repos().upsert("alice", "a");
    await repos().upsert("bob", "b");
    await repos().recordReconciliation({
      activeOrgs: new Set(["alice"]),
      activeRepos: new Set(),
    });
    expect((await repos().get("alice", "a"))?.status).toBe("missing");
    expect((await repos().get("bob", "b"))?.status).toBe("active");
  });

  test("case-insensitive owner comparison", async () => {
    await repos().upsert("Alice", "a");
    const r = await repos().recordReconciliation({
      activeOrgs: new Set(["alice"]),
      activeRepos: new Set([key("alice", "a")]),
    });
    expect(r.missing).toEqual([]);
  });

  test("no active orgs → no mutation", async () => {
    await repos().upsert("alice", "a");
    const r = await repos().recordReconciliation({
      activeOrgs: new Set<string>(),
      activeRepos: new Set(),
    });
    expect(r.missing).toEqual([]);
    expect((await repos().get("alice", "a"))?.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// orgs table
// ---------------------------------------------------------------------------

describe("upsertOrgStatus", () => {
  test("insert with active → no missing_at", async () => {
    const row = await repos().upsertOrgStatus("Alice", "active");
    expect(row.org).toBe("alice");
    expect(row.status).toBe("active");
    expect(row.missingAt).toBeNull();
    expect(row.lastError).toBeNull();
    expect(row.firstSeen).toMatch(ISO_RE);
  });

  test("insert with missing → missing_at set", async () => {
    const row = await repos().upsertOrgStatus("alice", "missing");
    expect(row.missingAt).toMatch(ISO_RE);
  });

  test("active → missing sets missing_at", async () => {
    await repos().upsertOrgStatus("alice", "active");
    const row = await repos().upsertOrgStatus("alice", "missing");
    expect(row.status).toBe("missing");
    expect(row.missingAt).toMatch(ISO_RE);
  });

  test("consecutive missing preserves missing_at", async () => {
    const a = await repos().upsertOrgStatus("alice", "missing");
    await new Promise((r) => setTimeout(r, 1100));
    const b = await repos().upsertOrgStatus("alice", "missing");
    expect(b.missingAt).toBe(a.missingAt);
    expect(b.updatedAt).not.toBe(a.updatedAt);
  });

  test("missing → active clears missing_at and last_error", async () => {
    await repos().upsertOrgStatus("alice", "missing", "404");
    const row = await repos().upsertOrgStatus("alice", "active");
    expect(row.status).toBe("active");
    expect(row.missingAt).toBeNull();
    expect(row.lastError).toBeNull();
  });

  test("active → no_installation does not set missing_at", async () => {
    await repos().upsertOrgStatus("alice", "active");
    const row = await repos().upsertOrgStatus("alice", "no_installation", "app not installed");
    expect(row.status).toBe("no_installation");
    expect(row.missingAt).toBeNull();
    expect(row.lastError).toBe("app not installed");
  });

  test("no_installation → active no missing_at mutation", async () => {
    await repos().upsertOrgStatus("alice", "no_installation");
    const row = await repos().upsertOrgStatus("alice", "active");
    expect(row.missingAt).toBeNull();
  });
});

describe("listOrgs", () => {
  test("returns all rows", async () => {
    await repos().upsertOrgStatus("a", "active");
    await repos().upsertOrgStatus("b", "missing");
    const rows = await repos().listOrgs();
    expect(rows.map((r) => r.org).sort()).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// independence: separate DO instances do not share state
// ---------------------------------------------------------------------------

describe("isolation", () => {
  test("different idFromName → separate state", async () => {
    const a = env.REPOS.get(env.REPOS.idFromName("a"));
    const b = env.REPOS.get(env.REPOS.idFromName("b"));
    await a.upsert("alice", "repo");
    expect(await b.get("alice", "repo")).toBeNull();
  });
});
