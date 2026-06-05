import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { describe, test, expect, afterEach } from "vitest";

import { discoverRepos } from "@/storage/discovery";

afterEach(async () => {
  await reset();
});

const repos = () => env.REPOS.getByName("global");

async function seed(keys: string[]) {
  for (const k of keys) await env.LFS_BUCKET.put(k, "x");
}

describe("discoverRepos", () => {
  test("discovers owner/repo pairs from R2", async () => {
    await seed([
      "alice/one/aaa",
      "alice/one/bbb",
      "alice/two/ccc",
      "bob/three/ddd",
    ]);
    const found = await discoverRepos(env.LFS_BUCKET, repos());
    expect(found.map((r) => `${r.owner}/${r.repo}`).sort()).toEqual([
      "alice/one",
      "alice/two",
      "bob/three",
    ]);
    const rows = await repos().listAll();
    expect(rows.map((r) => `${r.owner}/${r.repo}`).sort()).toEqual([
      "alice/one",
      "alice/two",
      "bob/three",
    ]);
  });

  test("is idempotent with existing repos (preserves firstSeen)", async () => {
    await seed(["alice/one/aaa"]);
    await discoverRepos(env.LFS_BUCKET, repos());
    const first = await repos().get("alice", "one");
    await new Promise((r) => setTimeout(r, 1100));
    await discoverRepos(env.LFS_BUCKET, repos());
    const second = await repos().get("alice", "one");
    expect(second?.firstSeen).toBe(first?.firstSeen);
    expect(second?.updatedAt).not.toBe(first?.updatedAt);
  });

  test("returns empty array when bucket is empty", async () => {
    const found = await discoverRepos(env.LFS_BUCKET, repos());
    expect(found).toEqual([]);
  });

  test("handles many keys across many repos (pagination path)", async () => {
    const owners = ["o1", "o2", "o3"];
    const keys: string[] = [];
    for (const o of owners) {
      for (let i = 0; i < 5; i++) keys.push(`${o}/r${i}/obj`);
    }
    await seed(keys);
    const found = await discoverRepos(env.LFS_BUCKET, repos());
    expect(found.length).toBe(15);
  });
});
