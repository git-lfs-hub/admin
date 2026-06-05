import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { describe, test, expect, afterEach } from "vitest";

afterEach(async () => {
  await reset();
});

const index = (key = "alice/thing") =>
  env.INDEX.get(env.INDEX.idFromName(key));

describe("RepoIndex.recordObject", () => {
  test("upload inserts as pending (R2 presence unconfirmed)", async () => {
    const row = await index().recordObject("oid1", 42, "upload");
    expect(row.oid).toBe("oid1");
    expect(row.size).toBe(42);
    expect(row.source).toBe("upload");
    expect(row.storageStatus).toBe("pending");
    expect(row.firstSeen).toBe(row.lastSeen);
    expect(row.lastAccessed).toBe(row.firstSeen);
  });

  test("verify/download insert as present", async () => {
    expect((await index("a/v").recordObject("o", 1, "verify")).storageStatus).toBe("present");
    expect((await index("a/d").recordObject("o", 1, "download")).storageStatus).toBe("present");
  });

  test("verify confirms a pending upload to present", async () => {
    const idx = index();
    expect((await idx.recordObject("oid1", 1, "upload")).storageStatus).toBe("pending");
    expect((await idx.recordObject("oid1", 1, "verify")).storageStatus).toBe("present");
  });

  test("upload does not downgrade an already-present object", async () => {
    const idx = index();
    await idx.recordObject("oid1", 1, "download");
    expect((await idx.recordObject("oid1", 1, "upload")).storageStatus).toBe("present");
  });

  test("verify is stored as verify source", async () => {
    const row = await index().recordObject("oid1", 7, "verify");
    expect(row.source).toBe("verify");
  });

  test("download is stored as download source", async () => {
    const row = await index().recordObject("oid1", 7, "download");
    expect(row.source).toBe("download");
  });

  test("re-record preserves firstSeen, advances lastSeen", async () => {
    const idx = index();
    const a = await idx.recordObject("oid1", 10, "upload");
    await new Promise((r) => setTimeout(r, 1100));
    const b = await idx.recordObject("oid1", 10, "upload");
    expect(b.firstSeen).toBe(a.firstSeen);
    expect(b.lastSeen).not.toBe(a.lastSeen);
  });

  test("every event bumps lastAccessed", async () => {
    const idx = index();
    const a = await idx.recordObject("oid1", 10, "upload");
    await new Promise((r) => setTimeout(r, 1100));
    const afterUpload = await idx.recordObject("oid1", 10, "upload");
    expect(afterUpload.lastAccessed).not.toBe(a.lastAccessed);
  });

  test("separate repos get separate indexes", async () => {
    await index("alice/one").recordObject("oid1", 1, "upload");
    expect(await index("alice/one").listAll()).toHaveLength(1);
    expect(await index("alice/two").listAll()).toHaveLength(0);
  });
});

describe("RepoIndex.usage", () => {
  test("breaks down count and size per status", async () => {
    const idx = index();
    await idx.recordObject("p1", 10, "download"); // present
    await idx.recordObject("p2", 5, "verify"); // present
    await idx.recordObject("u1", 99, "upload"); // pending
    const usage = await idx.usage();
    expect(usage.present).toEqual({ count: 2, size: 15 });
    expect(usage.pending).toEqual({ count: 1, size: 99 });
    expect(usage.missing).toEqual({ count: 0, size: 0 });
  });

  test("zero-fills every status for an empty index", async () => {
    expect(await index().usage()).toEqual({
      pending: { count: 0, size: 0 },
      present: { count: 0, size: 0 },
      missing: { count: 0, size: 0 },
      deleted: { count: 0, size: 0 },
      purged: { count: 0, size: 0 },
    });
  });
});

describe("RepoIndex.recordReconciliation", () => {
  test("confirms pending, corrects sizes, and skips storage-absent objects", async () => {
    const idx = index();
    await idx.recordObject("pending", 7, "upload"); // pending, in storage
    await idx.recordObject("wrong", 1, "download"); // present, wrong size
    await idx.recordObject("orphan", 3, "upload"); // pending, not in storage

    const res = await idx.recordReconciliation({ pending: 7, wrong: 42 });
    expect(res).toEqual({ added: 0, confirmed: 1, resized: 1 });
    expect((await idx.get("pending"))?.storageStatus).toBe("present");
    expect((await idx.get("wrong"))?.size).toBe(42);
    expect((await idx.get("orphan"))?.storageStatus).toBe("pending");
  });

  test("adds objects present in storage but missing from the index", async () => {
    const idx = index();
    const res = await idx.recordReconciliation({ found: 99 });
    expect(res).toEqual({ added: 1, confirmed: 0, resized: 0 });
    const row = await idx.get("found");
    expect(row?.size).toBe(99);
    expect(row?.storageStatus).toBe("present");
    expect(row?.source).toBe("storage_scan");
  });

  test("adds a batch larger than SQLite's bound-variable limit in one call", async () => {
    const idx = index();
    // >100 rows: a single multi-row insert would exceed the bound-var limit.
    const sizes = Object.fromEntries(
      Array.from({ length: 250 }, (_, i) => [`oid-${i}`, i + 1]),
    );
    const res = await idx.recordReconciliation(sizes);
    expect(res).toEqual({ added: 250, confirmed: 0, resized: 0 });
    expect((await idx.get("oid-0"))?.size).toBe(1);
    expect((await idx.get("oid-249"))?.size).toBe(250);
  });
});
