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
