import { test, expect, vi, beforeEach, describe } from "vitest";
import { Hono } from "hono";

const discoverRepos = vi.fn(async () => {});
const reconcileAll = vi.fn(async () => {});
const handleObjectEvents = vi.fn(async () => {});

vi.mock("@/storage/discovery", () => ({ discoverRepos: (...a: unknown[]) => discoverRepos(...a) }));
vi.mock("@/reconcile/index", () => ({ reconcileAll: (...a: unknown[]) => reconcileAll(...a) }));
vi.mock("@/server/object-events", () => ({
  handleObjectEvents: (...a: unknown[]) => handleObjectEvents(...a),
}));
vi.mock("@/db/repos", () => ({ Repos: class {} }));
vi.mock("@/db/repo-index", () => ({ RepoIndex: class {} }));
// Route/middleware modules pull heavy deps; stub them — index wiring is what we test.
vi.mock("@/middleware/auth", () => ({ default: async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock("@/api/me", () => ({ default: new Hono() }));
vi.mock("@/api/repos", () => ({ default: new Hono() }));
vi.mock("@/login/oauth", () => ({ default: new Hono() }));

import worker from "@/index";

const reposStub = { id: "repos" };

function makeEnv() {
  return {
    REPOS: { idFromName: vi.fn(() => "global-id"), get: vi.fn(() => reposStub) },
    LFS_BUCKET: { bucket: true },
    ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
  } as any;
}

beforeEach(() => {
  discoverRepos.mockClear();
  reconcileAll.mockClear();
  handleObjectEvents.mockClear();
});

describe("scheduled", () => {
  test("delegates the cron pipeline to reconcileAll", async () => {
    const env = makeEnv();
    const ctx = { waitUntil: vi.fn() } as any;
    await worker.scheduled!({} as any, env, ctx);
    await ctx.waitUntil.mock.calls[0][0];
    expect(reconcileAll).toHaveBeenCalledWith(env);
  });
});

describe("queue", () => {
  test("delegates the batch to handleObjectEvents", async () => {
    const env = makeEnv();
    const batch = { messages: [] } as any;
    await worker.queue!(batch, env, {} as any);
    expect(handleObjectEvents).toHaveBeenCalledWith(batch, env);
  });
});

describe("dev discovery middleware", () => {
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any;

  test("non-local host does not fire discovery", async () => {
    const env = makeEnv();
    await worker.fetch!(new Request("https://example.com/api/me"), env, ctx);
    expect(discoverRepos).not.toHaveBeenCalled();
  });

  test("localhost fires discovery exactly once across requests", async () => {
    const env = makeEnv();
    await worker.fetch!(new Request("http://localhost/api/me"), env, ctx);
    await worker.fetch!(new Request("http://localhost/api/me"), env, ctx);
    expect(discoverRepos).toHaveBeenCalledTimes(1);
    expect(discoverRepos).toHaveBeenCalledWith(env.LFS_BUCKET, reposStub);
  });
});
