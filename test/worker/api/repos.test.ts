import { reset } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, test, expect, afterEach, vi } from 'vitest';

import reposApp from '@/api/repos';
import { Repo, type LfsConfig } from '@/db/repo';

afterEach(async () => {
  await reset();
});

const reg = () => env.REGISTRY.getByName('global');

// Drive the sub-app directly: the full localhost fetch fires the dev reconcile, which seeds
// git `repos` from the fixture. A fabricated env (real REGISTRY/STORAGE) isolates the data.
const appEnv = () =>
  ({ REGISTRY: env.REGISTRY, STORAGE: env.STORAGE, GC: env.GC }) as unknown as CloudflareBindings;
const get = () => reposApp.request('/', {}, appEnv());

describe('GET /api/repos', () => {
  test('returns empty array when no repos exist', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repos: [] });
  });

  test('returns git presence rows with status', async () => {
    await reg().upsertRepo('alice', 'live');
    await reg().upsertRepo('bob', 'gone');
    await reg().markMissing('bob', 'gone');

    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repos: Array<{ owner: string; repo: string; status: string; missingAt: string | null }>;
    };
    const byRepo = Object.fromEntries(body.repos.map((r) => [r.repo, r]));
    expect(byRepo.live.status).toBe('active');
    expect(byRepo.live.missingAt).toBeNull();
    expect(byRepo.gone.status).toBe('missing');
    expect(byRepo.gone.missingAt).toBeTruthy();
  });

  test('cross-links consumed prefixes from links; empty when unlinked', async () => {
    await reg().upsertRepo('alice', 'a');
    await reg().upsertStorage('alice/a');
    await reg().upsertStorage('alice/a-mirror');
    await reg().syncLinks('alice', 'a', new Set(['alice/a', 'alice/a-mirror']));
    await reg().upsertRepo('bob', 'nostore');

    const res = await get();
    const body = (await res.json()) as {
      repos: Array<{ repo: string; storage: Array<{ prefix: string; status: string }> }>;
    };
    const byRepo = Object.fromEntries(body.repos.map((r) => [r.repo, r]));
    expect(byRepo.a.storage).toEqual([
      { prefix: 'alice/a', status: 'pending', archivedAt: null },
      { prefix: 'alice/a-mirror', status: 'pending', archivedAt: null },
    ]);
    expect(byRepo.nostore.storage).toEqual([]);
  });

  test('returns 401 without session on production host', async () => {
    const res = await exports.default.fetch('http://admin.example.com/api/repos');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
  });
});

// The LFS_SERVER service binding is stripped from the test wrangler, so drive the sub-app with a
// fabricated env carrying a stub server we assert on. A `localhost` request host trips `isLocal`,
// so `requireOwnerAdmin` admits the call without an authed identity.
function branchEnv(lfs: Partial<Record<'blockObjects' | 'unblockObjects', unknown>> = {}) {
  const LFS_SERVER = {
    blockObjects: vi.fn(async () => {}),
    unblockObjects: vi.fn(async () => {}),
    purgeObjects: vi.fn(async () => {}),
    ...lfs,
  };
  const e = {
    REGISTRY: env.REGISTRY,
    STORAGE: env.STORAGE,
    REPO: env.REPO,
    GC: env.GC,
    LFS_SERVER,
  } as unknown as CloudflareBindings;
  return { e, LFS_SERVER };
}

const local = (prefix: string): LfsConfig => ({
  sha: `cfg-${prefix}`,
  host: env.LFS.server.toLowerCase(),
  prefix,
  local: true,
  status: 'ok',
});

// A scanned (fresh, clean), `active` branch linked to `prefix` and referencing `oids`.
async function seedBranch(owner: string, repo: string, name: string, prefix: string, oids: string[]) {
  const r = Repo.byRepo(env, owner, repo);
  await r.recordLfsconfig(name, `h-${name}`, local(prefix));
  await r.setTip(name, { headSha: `h-${name}`, treeSha: `t-${name}`, gitattrSha: null });
  await r.replaceRefPaths(
    name,
    oids.map((oid, i) => ({ oid, path: `${name}/${i}.bin` })),
  );
}

// Mark the prefix's objects `present` (verify source), as a download/verify would.
async function seedObjects(prefix: string, oids: string[]) {
  const store = env.STORAGE.getByName(prefix);
  for (const oid of oids) await store.recordObject(oid, 10, 'verify');
}

const post = (path: string, e: CloudflareBindings) =>
  reposApp.request(`http://localhost${path}`, { method: 'POST' }, e);

describe('GET /api/repos/:owner/:repo/branches', () => {
  test('lists branches with lfsconfig, prefix usage, and willPurgeAt', async () => {
    await seedBranch('alice', 'app', 'main', 'alice/app', ['o1', 'o2']);
    await seedObjects('alice/app', ['o1', 'o2']);
    const { e } = branchEnv();

    const res = await reposApp.request('http://localhost/alice/app/branches', {}, e);
    expect(res.status).toBe(200);
    const { branches } = (await res.json()) as {
      branches: Array<{
        branch: string;
        status: string;
        lfsconfig: { prefix: string; local: boolean } | null;
        prefixUsage: { total: { count: number }; blocked: { count: number } } | null;
        willPurgeAt: string | null;
      }>;
    };
    const main = branches.find((b) => b.branch === 'main')!;
    expect(main.status).toBe('active');
    expect(main.lfsconfig).toMatchObject({ prefix: 'alice/app', local: true });
    expect(main.prefixUsage?.total.count).toBe(2);
    expect(main.prefixUsage?.blocked.count).toBe(0);
    expect(main.willPurgeAt).toBeNull();
  });
});

describe('POST /api/repos/:owner/:repo/branches/:branch — confirm / undelete', () => {
  // C7 smoke: delete a branch → only its orphan OIDs block (server + storage) → undelete restores.
  test('delete blocks orphan OIDs; undelete unblocks them', async () => {
    await seedBranch('alice', 'app', 'main', 'alice/app', ['o1', 'o2']);
    await seedBranch('alice', 'app', 'feat', 'alice/app', ['o2', 'o3']);
    await seedObjects('alice/app', ['o1', 'o2', 'o3']);
    const { e, LFS_SERVER } = branchEnv();

    const del = await post('/alice/app/branches/feat/delete', e);
    expect(del.status).toBe(200);
    // o2 stays live (main still references it); only o3 is forfeited.
    expect(await del.json()).toMatchObject({ blocked: ['o3'], unblocked: [] });
    expect(LFS_SERVER.blockObjects).toHaveBeenCalledWith('alice', 'app', ['o3']);
    const store = env.STORAGE.getByName('alice/app');
    expect((await store.getObject('o3'))?.status).toBe('deleted');
    expect((await store.getObject('o2'))?.status).toBe('present');
    expect((await Repo.byRepo(env, 'alice', 'app').getBranch('feat'))?.status).toBe('deleted');

    const undel = await post('/alice/app/branches/feat/undelete', e);
    expect(undel.status).toBe(200);
    expect(LFS_SERVER.unblockObjects).toHaveBeenCalledWith('alice', 'app', ['o3']);
    expect((await store.getObject('o3'))?.status).toBe('present');
    expect((await Repo.byRepo(env, 'alice', 'app').getBranch('feat'))?.status).toBe('active');
  });

  test('404 on an unknown branch', async () => {
    const { e } = branchEnv();
    const res = await post('/alice/app/branches/ghost/delete', e);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });

  test('409 stale_scan when the branch was never scanned', async () => {
    const r = Repo.byRepo(env, 'alice', 'stale');
    await r.recordLfsconfig('main', 'h1', local('alice/stale')); // no setTip → scannedAt null
    const { e } = branchEnv();
    const res = await post('/alice/stale/branches/main/delete', e);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'stale_scan' });
  });

  test('409 stale_scan when the tip is dirty', async () => {
    const r = Repo.byRepo(env, 'alice', 'dirty');
    await r.recordLfsconfig('main', 'h1', local('alice/dirty'));
    await r.markDirty('main', 'h2');
    const { e } = branchEnv();
    const res = await post('/alice/dirty/branches/main/delete', e);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'stale_scan' });
  });

  test('409 not_local for an external lfsconfig', async () => {
    const r = Repo.byRepo(env, 'alice', 'ext');
    await r.recordLfsconfig('main', 'h1', {
      sha: 'cfg-remote',
      host: 'lfs.elsewhere.example',
      prefix: 'Other/Repo',
      local: false,
      status: 'ok',
    });
    await r.setTip('main', { headSha: 'h1', treeSha: 't1', gitattrSha: null });
    const { e } = branchEnv();
    const res = await post('/alice/ext/branches/main/delete', e);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'not_local' });
  });

  test('502 when the LFS server RPC fails (branch already flagged, retriable)', async () => {
    await seedBranch('alice', 'app', 'feat', 'alice/app', ['o3']);
    await seedObjects('alice/app', ['o3']);
    const { e } = branchEnv({
      blockObjects: vi.fn(async () => {
        throw new Error('server down');
      }),
    });
    const res = await post('/alice/app/branches/feat/delete', e);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'lfs_server_unavailable' });
    // The branch flag landed before the RPC; the next retry recomputes from there.
    expect((await Repo.byRepo(env, 'alice', 'app').getBranch('feat'))?.status).toBe('deleted');
  });
});
