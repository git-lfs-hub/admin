import { test, expect, vi, beforeEach, describe } from "vitest";
import { GithubError } from "@git-lfs-hub/lib/github";

const probeOrg = vi.fn();
vi.mock("@/github/probeOrg", () => ({
  probeOrg: (...args: unknown[]) => probeOrg(...args),
}));

const orgApiMock = vi.fn();
vi.mock("@git-lfs-hub/lib/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@git-lfs-hub/lib/github")>();
  return {
    ...actual,
    GithubApi: class {
      static async forApp(_appId: string, _appPrivateKey: string) { return new this(); }
      async orgApi(org: string) { return orgApiMock(org); }
    },
  };
});

import { reconcileRepos } from "@/reconcile/index";
import type { OrgProbeResult } from "@/github/probeOrg";

const env = { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k" } as any;

function fakeRepos(owners: string[]) {
  const orgStatuses: { org: string; status: string; error?: string | null }[] = [];
  let lastReconcileInput: { activeOrgs: Set<string>; activeRepos: Set<string> } | null = null;
  let recordResult = {
    missing: [] as unknown[],
    missingReappeared: [] as unknown[],
    deletedReappeared: [] as unknown[],
  };
  return {
    orgStatuses,
    setRecordResult(r: typeof recordResult) {
      recordResult = r;
    },
    getLastReconcileInput() {
      return lastReconcileInput;
    },
    listOwners: vi.fn(async () => owners),
    upsertOrgStatus: vi.fn(async (org: string, status: string, error?: string | null) => {
      orgStatuses.push({ org, status, error });
      return { org, status };
    }),
    recordReconciliation: vi.fn(async (input: { activeOrgs: Set<string>; activeRepos: Set<string> }) => {
      lastReconcileInput = input;
      return recordResult;
    }),
  } as any;
}

beforeEach(() => {
  probeOrg.mockReset();
  orgApiMock.mockReset();
  // default: orgApi returns a fake GithubOrgApi-shaped stub
  orgApiMock.mockResolvedValue({});
});

describe("reconcileRepos", () => {
  test("empty owners → no-op, no probe, no record", async () => {
    const repos = fakeRepos([]);
    const summary = await reconcileRepos(env, repos);
    expect(probeOrg).not.toHaveBeenCalled();
    expect(repos.recordReconciliation).not.toHaveBeenCalled();
    expect(summary.repos.active).toBe(0);
    expect(summary.orgs.active).toEqual([]);
  });

  test("single active org → activeRepos passed through", async () => {
    const repos = fakeRepos(["alice"]);
    probeOrg.mockResolvedValue({
      status: "active",
      activeRepos: new Set(["alice/foo"]),
    } satisfies OrgProbeResult);
    await reconcileRepos(env, repos);
    expect(repos.upsertOrgStatus).toHaveBeenCalledWith("alice", "active", null);
    expect(repos.getLastReconcileInput()).toEqual({
      activeOrgs: new Set(["alice"]),
      activeRepos: new Set(["alice/foo"]),
    });
  });

  test("non-active org not in activeOrgs; status recorded with error", async () => {
    const repos = fakeRepos(["a", "b"]);
    probeOrg
      .mockResolvedValueOnce({ status: "active", activeRepos: new Set(["a/x"]) })
      .mockResolvedValueOnce({ status: "forbidden", error: "403" });
    await reconcileRepos(env, repos);
    expect(repos.getLastReconcileInput()?.activeOrgs).toEqual(new Set(["a"]));
    expect(repos.orgStatuses).toEqual([
      { org: "a", status: "active", error: null },
      { org: "b", status: "forbidden", error: "403" },
    ]);
  });

  test("missing org → activeRepos union excludes it", async () => {
    const repos = fakeRepos(["a", "b"]);
    probeOrg
      .mockResolvedValueOnce({ status: "active", activeRepos: new Set(["a/x"]) })
      .mockResolvedValueOnce({ status: "missing", error: "404" });
    await reconcileRepos(env, repos);
    const input = repos.getLastReconcileInput()!;
    expect(input.activeOrgs).toEqual(new Set(["a"]));
    expect(input.activeRepos).toEqual(new Set(["a/x"]));
  });

  test("transient_error → no mutation on that org's rows", async () => {
    const repos = fakeRepos(["x"]);
    probeOrg.mockResolvedValue({ status: "transient_error", error: "5xx" });
    const r = await reconcileRepos(env, repos);
    expect(r.orgs.transient_error).toEqual(["x"]);
    expect(repos.getLastReconcileInput()?.activeOrgs).toEqual(new Set());
  });

  test("summary counts reflect record result", async () => {
    const repos = fakeRepos(["a"]);
    probeOrg.mockResolvedValue({ status: "active", activeRepos: new Set(["a/x", "a/y"]) });
    repos.setRecordResult({
      missing: [{}, {}],
      missingReappeared: [{}],
      deletedReappeared: [{}, {}, {}],
    });
    const r = await reconcileRepos(env, repos);
    expect(r.repos.active).toBe(2);
    expect(r.repos.missing).toBe(2);
    expect(r.repos.missingReappeared).toBe(1);
    expect(r.repos.deletedReappeared).toBe(3);
  });

  test("listing errors classified by code, no throw out of reconcileRepos", async () => {
    const repos = fakeRepos(["b", "c", "d"]);
    probeOrg
      .mockRejectedValueOnce(new GithubError("forbidden", "403"))
      .mockRejectedValueOnce(new GithubError("missing", "404"))
      .mockRejectedValueOnce(new GithubError("transient", "5xx"));
    const r = await reconcileRepos(env, repos);
    expect(r.orgs.forbidden).toEqual(["b"]);
    expect(r.orgs.missing).toEqual(["c"]);
    expect(r.orgs.transient_error).toEqual(["d"]);
    expect(repos.getLastReconcileInput()?.activeOrgs).toEqual(new Set());
  });

  test("acquisition no_installation classified, probeOrg not called for that org", async () => {
    const repos = fakeRepos(["ghost", "alice"]);
    orgApiMock
      .mockRejectedValueOnce(new GithubError("no_installation", "no install for ghost"))
      .mockResolvedValueOnce({});
    probeOrg.mockResolvedValueOnce({ status: "active", activeRepos: new Set(["alice/x"]) });
    const r = await reconcileRepos(env, repos);
    expect(r.orgs.no_installation).toEqual(["ghost"]);
    expect(r.orgs.active).toEqual(["alice"]);
    expect(probeOrg).toHaveBeenCalledTimes(1);
  });

  test("unauthorized → transient_error", async () => {
    const repos = fakeRepos(["a"]);
    orgApiMock.mockRejectedValueOnce(new GithubError("unauthorized", "401"));
    const r = await reconcileRepos(env, repos);
    expect(r.orgs.transient_error).toEqual(["a"]);
  });

  test("non-GithubError throw → transient_error with raw message", async () => {
    const repos = fakeRepos(["a"]);
    orgApiMock.mockRejectedValueOnce(new Error("boom"));
    const r = await reconcileRepos(env, repos);
    expect(repos.orgStatuses).toEqual([{ org: "a", status: "transient_error", error: "boom" }]);
  });
});
