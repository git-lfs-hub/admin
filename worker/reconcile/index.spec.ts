import { test, expect, vi, beforeEach, describe } from "vitest";

const discoverRepos = vi.fn(async (..._a: unknown[]) => {});
const reconcileRepos = vi.fn(async (..._a: unknown[]) => {});
const reconcileObjects = vi.fn(async (..._a: unknown[]) => {});

vi.mock("@/storage/discovery", () => ({ discoverRepos: (...a: unknown[]) => discoverRepos(...a) }));
vi.mock("@/reconcile/repos", () => ({ reconcileRepos: (...a: unknown[]) => reconcileRepos(...a) }));
vi.mock("@/reconcile/objects", () => ({ reconcileObjects: (...a: unknown[]) => reconcileObjects(...a) }));

import { reconcileAll } from "@/reconcile/index";

const reposStub = { id: "repos", listAll: vi.fn(async (): Promise<unknown[]> => []) };
const indexStub = { id: "index" };

function makeEnv() {
  return {
    REPOS: { idFromName: vi.fn(() => "global-id"), get: vi.fn(() => reposStub) },
    INDEX: { idFromName: vi.fn(() => "index-id"), get: vi.fn(() => indexStub) },
    LFS_BUCKET: { bucket: true },
  } as any;
}

beforeEach(() => {
  discoverRepos.mockClear();
  reconcileRepos.mockClear();
  reconcileObjects.mockClear();
  reposStub.listAll.mockClear();
});

describe("reconcileAll", () => {
  test("discovers then reconciles against the global Repos DO", async () => {
    const env = makeEnv();
    await reconcileAll(env);
    expect(env.REPOS.idFromName).toHaveBeenCalledWith("global");
    expect(discoverRepos).toHaveBeenCalledWith(env.LFS_BUCKET, reposStub);
    expect(reconcileRepos).toHaveBeenCalledWith(env, reposStub);
  });

  test("local flag skips reconcileRepos but still reconciles objects", async () => {
    const env = makeEnv();
    reposStub.listAll.mockResolvedValueOnce([{ name: "alice/a", status: "active" }]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await reconcileAll(env, true);
    expect(reconcileRepos).not.toHaveBeenCalled();
    expect(reconcileObjects).toHaveBeenCalledWith(env.LFS_BUCKET, indexStub, "alice/a/");
  });

  test("ENV=local skips reconcileRepos", async () => {
    const env = makeEnv();
    env.ENV = "local";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await reconcileAll(env);
    expect(reconcileRepos).not.toHaveBeenCalled();
  });

  test("reconciles objects per non-purged repo by name", async () => {
    const env = makeEnv();
    reposStub.listAll.mockResolvedValueOnce([
      { name: "alice/a", status: "active" },
      { name: "bob/b", status: "purged" },
    ]);
    await reconcileAll(env);
    expect(env.INDEX.idFromName).toHaveBeenCalledWith("alice/a");
    expect(env.INDEX.idFromName).not.toHaveBeenCalledWith("bob/b");
    expect(reconcileObjects).toHaveBeenCalledTimes(1);
    expect(reconcileObjects).toHaveBeenCalledWith(env.LFS_BUCKET, indexStub, "alice/a/");
  });

  test("object pass still runs when GitHub repo reconciliation throws", async () => {
    const env = makeEnv();
    reconcileRepos.mockRejectedValueOnce(new Error("no github creds"));
    reposStub.listAll.mockResolvedValueOnce([
      { name: "alice/a", status: "active" },
    ]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(reconcileAll(env)).resolves.toBeUndefined();
    expect(reconcileObjects).toHaveBeenCalledWith(env.LFS_BUCKET, indexStub, "alice/a/");
  });

  test("one repo's object failure does not abort the rest", async () => {
    const env = makeEnv();
    reposStub.listAll.mockResolvedValueOnce([
      { name: "alice/a", status: "active" },
      { name: "bob/b", status: "active" },
    ]);
    reconcileObjects.mockRejectedValueOnce(new Error("boom")); // alice/a fails
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reconcileAll(env);
    expect(reconcileObjects).toHaveBeenCalledTimes(2);
    expect(reconcileObjects).toHaveBeenCalledWith(env.LFS_BUCKET, indexStub, "bob/b/");
  });
});
