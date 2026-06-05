import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { describe, test, expect, afterEach } from "vitest";

import { reconcileAll } from "@/reconcile/index";

afterEach(async () => {
  await reset();
});

const index = (name: string) => env.INDEX.get(env.INDEX.idFromName(name));

async function seedR2(entries: [string, number][]) {
  for (const [k, size] of entries) await env.LFS_BUCKET.put(k, "x".repeat(size));
}

describe("reconcileAll", () => {
  test("populates the object index for every discovered repo", async () => {
    await seedR2([
      ["acme/a/o1", 1],
      ["acme/a/o2", 2],
      ["acme/b/o1", 3],
      ["acme/b/o2", 4],
      ["acme/b/o3", 5],
      ["acme/c/o1", 6],
    ]);

    await reconcileAll(env, true);

    for (const [name, count] of [["acme/a", 2], ["acme/b", 3], ["acme/c", 1]] as const) {
      const usage = await index(name).usage();
      expect(usage.present.count).toBe(count);
    }
  });
});
