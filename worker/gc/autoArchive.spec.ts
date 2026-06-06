import { describe, test, expect, vi, beforeEach } from "vitest";

import { autoArchive } from "@/gc/autoArchive";
import { isoNow, isoAddDays } from "@/lib/time";

const blockRepo = vi.fn(async () => {});
const env = { GC: { autoArchiveDays: 7 }, LFS_SERVER: { blockRepo } } as any;

function fakeRepos(missing: unknown[]) {
  return {
    listByStatus: vi.fn(async () => missing),
    block: vi.fn(async (owner: string, repo: string) => ({ owner, repo, archivedAt: isoNow() })),
  } as any;
}

const daysAgo = (n: number) => isoAddDays(isoNow(), -n);
const row = (over: Record<string, unknown>) => ({ owner: "a", repo: "r", name: "a/r", archivedAt: null, ...over });

beforeEach(() => blockRepo.mockReset());

describe("autoArchive", () => {
  test("grace elapsed → blockRepo then block (status untouched)", async () => {
    const repos = fakeRepos([row({ missingAt: daysAgo(8) })]); // 8 > autoArchiveDays 7
    const out = await autoArchive(env, repos);
    expect(blockRepo).toHaveBeenCalledWith("a", "r");
    expect(repos.block).toHaveBeenCalledWith("a", "r");
    expect(out).toHaveLength(1);
  });

  test("within grace → skipped", async () => {
    const repos = fakeRepos([row({ missingAt: daysAgo(1) })]);
    await autoArchive(env, repos);
    expect(blockRepo).not.toHaveBeenCalled();
    expect(repos.block).not.toHaveBeenCalled();
  });

  test("already blocked → skipped", async () => {
    const repos = fakeRepos([row({ missingAt: daysAgo(30), archivedAt: daysAgo(2) })]);
    await autoArchive(env, repos);
    expect(blockRepo).not.toHaveBeenCalled();
  });

  test("no missingAt → skipped", async () => {
    const repos = fakeRepos([row({ missingAt: null })]);
    await autoArchive(env, repos);
    expect(blockRepo).not.toHaveBeenCalled();
  });

  test("RPC failure → not blocked, no throw, continues", async () => {
    blockRepo.mockRejectedValueOnce(new Error("rpc down"));
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const repos = fakeRepos([
      row({ repo: "x", name: "a/x", missingAt: daysAgo(8) }),
      row({ repo: "y", name: "a/y", missingAt: daysAgo(8) }),
    ]);
    const out = await autoArchive(env, repos);
    expect(repos.block).toHaveBeenCalledTimes(1); // only the second succeeded
    expect(repos.block).toHaveBeenCalledWith("a", "y");
    expect(out).toHaveLength(1);
    warn.mockRestore();
  });
});
