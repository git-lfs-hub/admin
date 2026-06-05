import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { describe, test, expect, afterEach } from "vitest";

import { handleObjectEvents, type ObjectEvent } from "@/server/object-events";

afterEach(async () => {
  await reset();
});

const repos = () => env.REPOS.getByName("global");

function evt(over: Partial<ObjectEvent> = {}): ObjectEvent {
  return {
    owner: "alice",
    repo: "thing",
    oid: "abc",
    size: 10,
    operation: "upload",
    ...over,
  };
}

function makeBatch(events: ObjectEvent[]): MessageBatch<ObjectEvent> {
  return {
    queue: "lfs-object-events",
    messages: events.map((e, i) => ({
      id: `m-${i}`,
      timestamp: new Date(),
      body: e,
      attempts: 1,
      ack: () => {},
      retry: () => {},
    })),
    ackAll: () => {},
    retryAll: () => {},
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
  } as MessageBatch<ObjectEvent>;
}

describe("handleObjectEvents", () => {
  test("creates repo row on first message", async () => {
    await handleObjectEvents(makeBatch([evt()]), env);
    const row = await repos().get("alice", "thing");
    expect(row?.status).toBe("active");
    expect(row?.firstSeen).toMatch(/^\d{4}/);
  });

  test("duplicate batches preserve firstSeen, advance updatedAt", async () => {
    await handleObjectEvents(makeBatch([evt()]), env);
    const a = await repos().get("alice", "thing");
    await new Promise((r) => setTimeout(r, 1100));
    await handleObjectEvents(makeBatch([evt()]), env);
    const b = await repos().get("alice", "thing");
    expect(b?.firstSeen).toBe(a?.firstSeen);
    expect(b?.updatedAt).not.toBe(a?.updatedAt);
  });

  test("does not reset status on existing missing repo", async () => {
    await repos().upsert("alice", "thing");
    await repos().markMissing("alice", "thing");
    await handleObjectEvents(makeBatch([evt()]), env);
    expect((await repos().get("alice", "thing"))?.status).toBe("missing");
  });

  test("empty batch is no-op", async () => {
    await handleObjectEvents(makeBatch([]), env);
    expect(await repos().listAll()).toEqual([]);
  });

  test("op variants all upsert", async () => {
    await handleObjectEvents(
      makeBatch([
        evt({ repo: "a", operation: "upload" }),
        evt({ repo: "b", operation: "verify" }),
        evt({ repo: "c", operation: "download" }),
      ]),
      env,
    );
    expect((await repos().get("alice", "a"))?.status).toBe("active");
    expect((await repos().get("alice", "b"))?.status).toBe("active");
    expect((await repos().get("alice", "c"))?.status).toBe("active");
  });

  test("dedupes per-repo across messages in one batch", async () => {
    await handleObjectEvents(
      makeBatch([evt({ oid: "o1" }), evt({ oid: "o2" }), evt({ oid: "o3" })]),
      env,
    );
    const rows = await repos().listAll();
    expect(rows.length).toBe(1);
  });

  test("records each object with its size into the repo index", async () => {
    await handleObjectEvents(
      makeBatch([
        evt({ oid: "o1", size: 10 }),
        evt({ oid: "o2", size: 25 }),
        evt({ repo: "other", oid: "o3", size: 5 }),
      ]),
      env,
    );
    const thing = await env.REPO.getByName("alice/thing").listObjects();
    expect(thing.map((o) => [o.oid, o.size]).sort()).toEqual([
      ["o1", 10],
      ["o2", 25],
    ]);
    const other = await env.REPO.getByName("alice/other").listObjects();
    expect(other.map((o) => [o.oid, o.size])).toEqual([["o3", 5]]);
  });
});
