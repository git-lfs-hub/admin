import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { describe, test, expect, afterEach } from "vitest";

afterEach(async () => {
  await reset();
});

function stub() {
  return env.REPOS.get(env.REPOS.idFromName("global"));
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// ---------------------------------------------------------------------------
// upsert
// ---------------------------------------------------------------------------

describe("upsert", () => {
  test("inserts new row as active with timestamps", async () => {
    const row = await stub().upsert("alice", "repo");
    expect(row.owner).toBe("alice");
    expect(row.repo).toBe("repo");
    expect(row.status).toBe("active");
    expect(row.firstSeen).toMatch(ISO_RE);
    expect(row.updatedAt).toMatch(ISO_RE);
    expect(row.missingAt).toBeNull();
    expect(row.deletedAt).toBeNull();
    expect(row.purgedAt).toBeNull();
  });

  test("preserves firstSeen but updates updatedAt on second upsert", async () => {
    const a = await stub().upsert("alice", "repo");
    await new Promise((r) => setTimeout(r, 1100));
    const b = await stub().upsert("alice", "repo");
    expect(b.firstSeen).toBe(a.firstSeen);
    expect(b.updatedAt).not.toBe(a.updatedAt);
    expect(b.status).toBe("active");
  });

  test("does not reset status on existing row", async () => {
    await stub().upsert("alice", "repo");
    await stub().markMissing("alice", "repo");
    const row = await stub().upsert("alice", "repo");
    expect(row.status).toBe("missing");
  });

  test("normalizes owner/repo to lowercase on insert", async () => {
    const row = await stub().upsert("Alice", "MyRepo");
    expect(row.owner).toBe("alice");
    expect(row.repo).toBe("myrepo");
  });

  test("mixed-case + lowercase calls hit the same row", async () => {
    const a = await stub().upsert("Alice", "Foo");
    await stub().markMissing("ALICE", "FOO");
    const b = await stub().get("alice", "foo");
    expect(b?.status).toBe("missing");
    expect(b?.firstSeen).toBe(a.firstSeen);
    expect((await stub().listAll()).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// get / listByStatus
// ---------------------------------------------------------------------------

describe("get", () => {
  test("returns row when present", async () => {
    await stub().upsert("alice", "repo");
    const row = await stub().get("alice", "repo");
    expect(row?.owner).toBe("alice");
  });

  test("returns null when absent", async () => {
    expect(await stub().get("nope", "nope")).toBeNull();
  });
});

describe("listByStatus", () => {
  test("returns only repos with matching status", async () => {
    await stub().upsert("alice", "a");
    await stub().upsert("alice", "b");
    await stub().upsert("bob", "c");
    await stub().markMissing("alice", "a");

    const active = await stub().listByStatus("active");
    const missing = await stub().listByStatus("missing");
    expect(active.map((r) => r.repo).sort()).toEqual(["b", "c"]);
    expect(missing.map((r) => r.repo)).toEqual(["a"]);
  });

  test("returns empty array when none match", async () => {
    expect(await stub().listByStatus("deleted")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// transitions
// ---------------------------------------------------------------------------

describe("markMissing", () => {
  test("active → missing sets missing_at", async () => {
    await stub().upsert("alice", "repo");
    const row = await stub().markMissing("alice", "repo");
    expect(row?.status).toBe("missing");
    expect(row?.missingAt).toMatch(ISO_RE);
  });

  test("returns null when repo does not exist", async () => {
    expect(await stub().markMissing("nope", "nope")).toBeNull();
  });

  test("returns null when status is not active", async () => {
    await stub().upsert("alice", "repo");
    await stub().markMissing("alice", "repo");
    expect(await stub().markMissing("alice", "repo")).toBeNull();
  });
});

describe("markActive", () => {
  test("missing → active clears missing_at", async () => {
    await stub().upsert("alice", "repo");
    await stub().markMissing("alice", "repo");
    const row = await stub().markActive("alice", "repo");
    expect(row?.status).toBe("active");
    expect(row?.missingAt).toBeNull();
  });

  test("deleted → active clears deleted_at", async () => {
    await stub().upsert("alice", "repo");
    await stub().markMissing("alice", "repo");
    await stub().markDeleted("alice", "repo");
    const row = await stub().markActive("alice", "repo");
    expect(row?.status).toBe("active");
    expect(row?.missingAt).toBeNull();
    expect(row?.deletedAt).toBeNull();
  });

  test("returns null when already active", async () => {
    await stub().upsert("alice", "repo");
    expect(await stub().markActive("alice", "repo")).toBeNull();
  });

  test("returns null when purged", async () => {
    await stub().upsert("alice", "repo");
    await stub().markMissing("alice", "repo");
    await stub().markDeleted("alice", "repo");
    await stub().markPurged("alice", "repo");
    expect(await stub().markActive("alice", "repo")).toBeNull();
  });

  test("returns null when repo does not exist", async () => {
    expect(await stub().markActive("nope", "nope")).toBeNull();
  });
});

describe("markDeleted", () => {
  test("missing → deleted sets deleted_at", async () => {
    await stub().upsert("alice", "repo");
    await stub().markMissing("alice", "repo");
    const row = await stub().markDeleted("alice", "repo");
    expect(row?.status).toBe("deleted");
    expect(row?.deletedAt).toMatch(ISO_RE);
  });

  test("returns null when status is active", async () => {
    await stub().upsert("alice", "repo");
    expect(await stub().markDeleted("alice", "repo")).toBeNull();
  });

  test("returns null when already deleted", async () => {
    await stub().upsert("alice", "repo");
    await stub().markMissing("alice", "repo");
    await stub().markDeleted("alice", "repo");
    expect(await stub().markDeleted("alice", "repo")).toBeNull();
  });

  test("returns null when repo does not exist", async () => {
    expect(await stub().markDeleted("nope", "nope")).toBeNull();
  });
});

describe("markPurged", () => {
  test("deleted → purged sets purged_at", async () => {
    await stub().upsert("alice", "repo");
    await stub().markMissing("alice", "repo");
    await stub().markDeleted("alice", "repo");
    const row = await stub().markPurged("alice", "repo");
    expect(row?.status).toBe("purged");
    expect(row?.purgedAt).toMatch(ISO_RE);
  });

  test("returns null when status is missing", async () => {
    await stub().upsert("alice", "repo");
    await stub().markMissing("alice", "repo");
    expect(await stub().markPurged("alice", "repo")).toBeNull();
  });

  test("returns null when repo does not exist", async () => {
    expect(await stub().markPurged("nope", "nope")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listOwners
// ---------------------------------------------------------------------------

describe("listOwners", () => {
  test("returns distinct lowercased owners across active|missing|deleted", async () => {
    await stub().upsert("Alice", "a");
    await stub().upsert("alice", "b");
    await stub().upsert("Bob", "c");
    await stub().upsert("Carol", "d");
    await stub().markMissing("Bob", "c");
    await stub().markMissing("Carol", "d");
    await stub().markDeleted("Carol", "d");
    const owners = (await stub().listOwners()).sort();
    expect(owners).toEqual(["alice", "bob", "carol"]);
  });

  test("excludes purged-only owners", async () => {
    await stub().upsert("alice", "a");
    await stub().markMissing("alice", "a");
    await stub().markDeleted("alice", "a");
    await stub().markPurged("alice", "a");
    expect(await stub().listOwners()).toEqual([]);
  });

  test("empty → []", async () => {
    expect(await stub().listOwners()).toEqual([]);
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
    await stub().upsert("alice", "a");
    await stub().upsert("alice", "b");
    const r = await stub().recordReconciliation({
      activeOrgs: new Set(["alice"]),
      activeRepos: new Set([key("alice", "a")]),
    });
    expect(r.missing.map((x) => x.repo)).toEqual(["b"]);
    expect(r.missingReappeared).toEqual([]);
    expect(r.deletedReappeared).toEqual([]);
    expect((await stub().get("alice", "b"))?.status).toBe("missing");
    expect((await stub().get("alice", "a"))?.status).toBe("active");
  });

  test("missing present → reappeared (active, missing_at cleared)", async () => {
    await stub().upsert("alice", "a");
    await stub().markMissing("alice", "a");
    const r = await stub().recordReconciliation({
      activeOrgs: new Set(["alice"]),
      activeRepos: new Set([key("alice", "a")]),
    });
    expect(r.missingReappeared.map((x) => x.repo)).toEqual(["a"]);
    const row = await stub().get("alice", "a");
    expect(row?.status).toBe("active");
    expect(row?.missingAt).toBeNull();
  });

  test("deleted present → deletedReappeared, not mutated", async () => {
    await stub().upsert("alice", "a");
    await stub().markMissing("alice", "a");
    await stub().markDeleted("alice", "a");
    const r = await stub().recordReconciliation({
      activeOrgs: new Set(["alice"]),
      activeRepos: new Set([key("alice", "a")]),
    });
    expect(r.deletedReappeared.map((x) => x.repo)).toEqual(["a"]);
    expect((await stub().get("alice", "a"))?.status).toBe("deleted");
  });

  test("purged untouched", async () => {
    await stub().upsert("alice", "a");
    await stub().markMissing("alice", "a");
    await stub().markDeleted("alice", "a");
    await stub().markPurged("alice", "a");
    const r = await stub().recordReconciliation({
      activeOrgs: new Set(["alice"]),
      activeRepos: new Set(),
    });
    expect(r.missing).toEqual([]);
    expect((await stub().get("alice", "a"))?.status).toBe("purged");
  });

  test("rows from non-active orgs untouched", async () => {
    await stub().upsert("alice", "a");
    await stub().upsert("bob", "b");
    await stub().recordReconciliation({
      activeOrgs: new Set(["alice"]),
      activeRepos: new Set(),
    });
    expect((await stub().get("alice", "a"))?.status).toBe("missing");
    expect((await stub().get("bob", "b"))?.status).toBe("active");
  });

  test("case-insensitive owner comparison", async () => {
    await stub().upsert("Alice", "a");
    const r = await stub().recordReconciliation({
      activeOrgs: new Set(["alice"]),
      activeRepos: new Set([key("alice", "a")]),
    });
    expect(r.missing).toEqual([]);
  });

  test("no active orgs → no mutation", async () => {
    await stub().upsert("alice", "a");
    const r = await stub().recordReconciliation({
      activeOrgs: new Set<string>(),
      activeRepos: new Set(),
    });
    expect(r.missing).toEqual([]);
    expect((await stub().get("alice", "a"))?.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// orgs table
// ---------------------------------------------------------------------------

describe("upsertOrgStatus", () => {
  test("insert with active → no missing_at", async () => {
    const row = await stub().upsertOrgStatus("Alice", "active");
    expect(row.org).toBe("alice");
    expect(row.status).toBe("active");
    expect(row.missingAt).toBeNull();
    expect(row.lastError).toBeNull();
    expect(row.firstSeen).toMatch(ISO_RE);
  });

  test("insert with missing → missing_at set", async () => {
    const row = await stub().upsertOrgStatus("alice", "missing");
    expect(row.missingAt).toMatch(ISO_RE);
  });

  test("active → missing sets missing_at", async () => {
    await stub().upsertOrgStatus("alice", "active");
    const row = await stub().upsertOrgStatus("alice", "missing");
    expect(row.status).toBe("missing");
    expect(row.missingAt).toMatch(ISO_RE);
  });

  test("consecutive missing preserves missing_at", async () => {
    const a = await stub().upsertOrgStatus("alice", "missing");
    await new Promise((r) => setTimeout(r, 1100));
    const b = await stub().upsertOrgStatus("alice", "missing");
    expect(b.missingAt).toBe(a.missingAt);
    expect(b.updatedAt).not.toBe(a.updatedAt);
  });

  test("missing → active clears missing_at and last_error", async () => {
    await stub().upsertOrgStatus("alice", "missing", "404");
    const row = await stub().upsertOrgStatus("alice", "active");
    expect(row.status).toBe("active");
    expect(row.missingAt).toBeNull();
    expect(row.lastError).toBeNull();
  });

  test("active → no_installation does not set missing_at", async () => {
    await stub().upsertOrgStatus("alice", "active");
    const row = await stub().upsertOrgStatus("alice", "no_installation", "app not installed");
    expect(row.status).toBe("no_installation");
    expect(row.missingAt).toBeNull();
    expect(row.lastError).toBe("app not installed");
  });

  test("no_installation → active no missing_at mutation", async () => {
    await stub().upsertOrgStatus("alice", "no_installation");
    const row = await stub().upsertOrgStatus("alice", "active");
    expect(row.missingAt).toBeNull();
  });
});

describe("listOrgs", () => {
  test("returns all rows", async () => {
    await stub().upsertOrgStatus("a", "active");
    await stub().upsertOrgStatus("b", "missing");
    const rows = await stub().listOrgs();
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
