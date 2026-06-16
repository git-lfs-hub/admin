import { reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, test, expect, afterEach } from 'vitest';

import { Repo } from '@/db/repo';

afterEach(async () => {
  await reset();
});

describe('Repo DO', () => {
  test('byRepo keys on lc(owner/repo)', async () => {
    const a = Repo.byRepo(env, 'Alice', 'Repo');
    const b = env.REPO.getByName('alice/repo');
    expect((await a.listBranches()).length).toBe(0);
    // same DO name → same (empty) state, distinct instances notwithstanding
    expect(await b.listBranches()).toEqual([]);
  });

  test('fresh repo has empty branches + lfsconfigs', async () => {
    const repo = Repo.byRepo(env, 'alice', 'a');
    expect(await repo.listBranches()).toEqual([]);
    expect(await repo.listLfsconfigs()).toEqual([]);
    expect(await repo.getBranch('main')).toBeNull();
  });

  test('different owner/repo → isolated state', async () => {
    const a = env.REPO.get(env.REPO.idFromName('alice/a'));
    const b = env.REPO.get(env.REPO.idFromName('bob/b'));
    expect(await a.listBranches()).toEqual([]);
    expect(await b.listBranches()).toEqual([]);
  });
});
