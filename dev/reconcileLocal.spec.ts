import { describe, test, expect, vi, beforeEach } from "vitest";

import { reconcileLocal } from "@dev/reconcileLocal";

const unblockRepo = vi.fn(async () => {});
const env = { LFS_SERVER: { unblockRepo } } as any;

function fakeRepos(owners: string[]) {
  return {
    lastInput: null as { activeOrgs: Set<string>; activeRepos: Set<string> } | null,
    listOwners: vi.fn(async () => owners),
    unblock: vi.fn(async (owner: string, repo: string) => ({ owner, repo })),
    recordReconciliation: vi.fn(async function (this: any, input: any) {
      this.lastInput = input;
      return { missing: [], reappeared: [], blockedPresent: [] };
    }),
  } as any;
}

beforeEach(() => unblockRepo.mockReset());

describe("reconcileLocal", () => {
  test("present list → activeRepos; discovered owners → activeOrgs (lowercased)", async () => {
    const repos = fakeRepos(["acme", "globex"]);
    await reconcileLocal(env, repos, ["ACME/Keep", "globex/site"]);
    expect(repos.lastInput).toEqual({
      activeOrgs: new Set(["acme", "globex"]),
      activeRepos: new Set(["acme/keep", "globex/site"]),
    });
  });

  test("empty present list → every discovered repo evaluated as gone", async () => {
    const repos = fakeRepos(["acme"]);
    await reconcileLocal(env, repos, []);
    expect(repos.lastInput?.activeRepos).toEqual(new Set());
    expect(repos.recordReconciliation).toHaveBeenCalledOnce();
  });
});
