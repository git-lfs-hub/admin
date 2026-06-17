import { reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, test, expect, afterEach } from 'vitest';

afterEach(async () => {
  await reset();
});

const reg = () => env.REGISTRY.getByName('global');

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function key(owner: string, repo: string) {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// repos — GitHub presence (git identity)
// ---------------------------------------------------------------------------

describe('upsertRepo / getRepo', () => {
  test('inserts new row as active, lowercased key', async () => {
    const row = await reg().upsertRepo('Alice', 'Repo');
    expect(row.owner).toBe('alice');
    expect(row.repo).toBe('repo');
    expect(row.status).toBe('active');
    expect(row.firstSeen).toMatch(ISO_RE);
    expect(row.missingAt).toBeNull();
  });

  test('second upsert preserves firstSeen, bumps updatedAt, keeps status', async () => {
    const a = await reg().upsertRepo('alice', 'repo');
    await reg().markMissing('alice', 'repo');
    await new Promise((r) => setTimeout(r, 1100));
    const b = await reg().upsertRepo('alice', 'repo');
    expect(b.firstSeen).toBe(a.firstSeen);
    expect(b.updatedAt).not.toBe(a.updatedAt);
    expect(b.status).toBe('missing');
  });

  test('getRepo returns null when absent', async () => {
    expect(await reg().getRepo('nope', 'nope')).toBeNull();
  });

  test('listRepos returns all rows', async () => {
    await reg().upsertRepo('alice', 'a');
    await reg().upsertRepo('bob', 'b');
    expect((await reg().listRepos()).map((r) => r.repo).sort()).toEqual(['a', 'b']);
  });
});

describe('markMissing / markActive', () => {
  test('active → missing sets missing_at', async () => {
    await reg().upsertRepo('alice', 'repo');
    const row = await reg().markMissing('alice', 'repo');
    expect(row?.status).toBe('missing');
    expect(row?.missingAt).toMatch(ISO_RE);
  });

  test('missing → active clears missing_at', async () => {
    await reg().upsertRepo('alice', 'repo');
    await reg().markMissing('alice', 'repo');
    const row = await reg().markActive('alice', 'repo');
    expect(row?.status).toBe('active');
    expect(row?.missingAt).toBeNull();
  });

  test('markMissing is a no-op (null) when not active', async () => {
    await reg().upsertRepo('alice', 'repo');
    await reg().markMissing('alice', 'repo');
    expect(await reg().markMissing('alice', 'repo')).toBeNull();
  });
});

describe('recordReconciliation (git presence)', () => {
  test('creates active rows for listed repos', async () => {
    const r = await reg().recordReconciliation({
      activeOrgs: new Set(['alice']),
      activeRepos: new Set([key('alice', 'a'), key('alice', 'b')]),
    });
    expect(r.missing).toEqual([]);
    expect((await reg().getRepo('alice', 'a'))?.status).toBe('active');
    expect((await reg().getRepo('alice', 'b'))?.status).toBe('active');
  });

  test('listed-absent → missing', async () => {
    await reg().upsertRepo('alice', 'a');
    await reg().upsertRepo('alice', 'b');
    const r = await reg().recordReconciliation({
      activeOrgs: new Set(['alice']),
      activeRepos: new Set([key('alice', 'a')]),
    });
    expect(r.missing.map((x) => x.repo)).toEqual(['b']);
    expect((await reg().getRepo('alice', 'b'))?.status).toBe('missing');
  });

  test('missing present again → reappeared (active, missing_at cleared)', async () => {
    await reg().upsertRepo('alice', 'a');
    await reg().markMissing('alice', 'a');
    const r = await reg().recordReconciliation({
      activeOrgs: new Set(['alice']),
      activeRepos: new Set([key('alice', 'a')]),
    });
    expect(r.reappeared.map((x) => x.repo)).toEqual(['a']);
    expect((await reg().getRepo('alice', 'a'))?.missingAt).toBeNull();
  });

  test('rows from non-active orgs untouched', async () => {
    await reg().upsertRepo('alice', 'a');
    await reg().upsertRepo('bob', 'b');
    await reg().recordReconciliation({ activeOrgs: new Set(['alice']), activeRepos: new Set() });
    expect((await reg().getRepo('alice', 'a'))?.status).toBe('missing');
    expect((await reg().getRepo('bob', 'b'))?.status).toBe('active');
  });

  test('no active orgs → no mutation', async () => {
    await reg().upsertRepo('alice', 'a');
    const r = await reg().recordReconciliation({
      activeOrgs: new Set<string>(),
      activeRepos: new Set(),
    });
    expect(r.missing).toEqual([]);
    expect((await reg().getRepo('alice', 'a'))?.status).toBe('active');
  });
});

describe('applyRepoEvent (webhook)', () => {
  test('active + absent → missing', async () => {
    await reg().upsertRepo('alice', 'a');
    const res = await reg().applyRepoEvent('alice', 'a', false);
    expect(res?.row.status).toBe('missing');
    expect(res?.reappeared).toBe(false);
  });

  test('missing + present → reappeared', async () => {
    await reg().upsertRepo('alice', 'a');
    await reg().markMissing('alice', 'a');
    const res = await reg().applyRepoEvent('alice', 'a', true);
    expect(res?.row.status).toBe('active');
    expect(res?.reappeared).toBe(true);
  });

  test('untracked + present → creates active row', async () => {
    const res = await reg().applyRepoEvent('alice', 'new', true);
    expect(res?.row.status).toBe('active');
    expect(res?.reappeared).toBe(false);
  });

  test('untracked + absent → null', async () => {
    expect(await reg().applyRepoEvent('nope', 'nope', false)).toBeNull();
  });

  test('idempotent: already-missing + absent → null', async () => {
    await reg().upsertRepo('alice', 'a');
    await reg().markMissing('alice', 'a');
    expect(await reg().applyRepoEvent('alice', 'a', false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// storage — prefix lifecycle
// ---------------------------------------------------------------------------

describe('upsertStorage / getStorage', () => {
  test('inserts new prefix as used with null lifecycle fields', async () => {
    const row = await reg().upsertStorage('Alice/Repo');
    expect(row.prefix).toBe('Alice/Repo');
    expect(row.status).toBe('used');
    expect(row.unusedAt).toBeNull();
    expect(row.archivedAt).toBeNull();
    expect(row.backupComplete).toBe(false);
    expect(row.activeOp).toBeNull();
  });

  test('second upsert preserves firstSeen, bumps updatedAt', async () => {
    const a = await reg().upsertStorage('Alice/Repo');
    await new Promise((r) => setTimeout(r, 1100));
    const b = await reg().upsertStorage('Alice/Repo');
    expect(b.firstSeen).toBe(a.firstSeen);
    expect(b.updatedAt).not.toBe(a.updatedAt);
  });
});

describe('block / unblock', () => {
  test('block sets archivedAt without changing status', async () => {
    await reg().upsertStorage('alice/a');
    const row = await reg().block('alice/a');
    expect(row?.status).toBe('used');
    expect(row?.archivedAt).toMatch(ISO_RE);
  });

  test('block returns null when already blocked', async () => {
    await reg().upsertStorage('alice/a');
    await reg().block('alice/a');
    expect(await reg().block('alice/a')).toBeNull();
  });

  test('unblock clears archivedAt; null when not blocked', async () => {
    await reg().upsertStorage('alice/a');
    expect(await reg().unblock('alice/a')).toBeNull();
    await reg().block('alice/a');
    const row = await reg().unblock('alice/a');
    expect(row?.archivedAt).toBeNull();
  });
});

describe('markUsed / markUnused / markPurged', () => {
  test('markUnused sets unusedAt; markUsed clears it', async () => {
    await reg().upsertStorage('alice/a');
    const u = await reg().markUnused('alice/a');
    expect(u?.status).toBe('unused');
    expect(u?.unusedAt).toMatch(ISO_RE);
    const used = await reg().markUsed('alice/a');
    expect(used?.status).toBe('used');
    expect(used?.unusedAt).toBeNull();
  });

  test('markPurged only on a blocked prefix', async () => {
    await reg().upsertStorage('alice/a');
    await reg().markUnused('alice/a');
    expect(await reg().markPurged('alice/a')).toBeNull(); // not blocked
    await reg().block('alice/a');
    const row = await reg().markPurged('alice/a');
    expect(row?.status).toBe('purged');
    expect(row?.purgedAt).toMatch(ISO_RE);
  });
});

describe('markCleared', () => {
  test('stamps clearedAt only on a blocked, not-yet-cleared prefix', async () => {
    await reg().upsertStorage('alice/a');
    await reg().markUnused('alice/a');
    expect(await reg().markCleared('alice/a')).toBeNull(); // not blocked
    await reg().block('alice/a');
    const row = await reg().markCleared('alice/a');
    expect(row?.clearedAt).toMatch(ISO_RE);
    expect(row?.status).toBe('unused');
    expect(row?.archivedAt).toMatch(ISO_RE);
    expect(await reg().markCleared('alice/a')).toBeNull(); // already cleared → no-op
  });
});

describe('reconcileStorage (link state from links)', () => {
  test('linked repo missing → prefix becomes unused', async () => {
    await reg().upsertRepo('alice', 'a');
    await reg().upsertStorage('Alice/A');
    await reg().syncLinks('alice', 'a', new Set(['Alice/A']));
    // active repo + active link: no flip
    let res = await reg().reconcileStorage();
    expect(res.becameUnused).toEqual([]);
    await reg().markMissing('alice', 'a');
    res = await reg().reconcileStorage();
    expect(res.becameUnused.map((s) => s.prefix)).toEqual(['Alice/A']);
    expect((await reg().getStorage('Alice/A'))?.status).toBe('unused');
  });

  test('no link → unused', async () => {
    await reg().upsertRepo('alice', 'a'); // active repo, but no link to the prefix
    await reg().upsertStorage('orphan/prefix');
    const res = await reg().reconcileStorage();
    expect(res.becameUnused.map((s) => s.prefix)).toEqual(['orphan/prefix']);
  });

  test('shared prefix stays used while any linked repo is active', async () => {
    await reg().upsertStorage('shared/p');
    await reg().upsertRepo('alice', 'a');
    await reg().upsertRepo('bob', 'b');
    await reg().syncLinks('alice', 'a', new Set(['shared/p']));
    await reg().syncLinks('bob', 'b', new Set(['shared/p']));
    await reg().markMissing('alice', 'a');
    let res = await reg().reconcileStorage();
    expect(res.becameUnused).toEqual([]); // bob still links it
    await reg().markMissing('bob', 'b');
    res = await reg().reconcileStorage();
    expect(res.becameUnused.map((s) => s.prefix)).toEqual(['shared/p']); // now orphaned
  });

  test('repo reappears while blocked → becameUsed + blockedReused', async () => {
    await reg().upsertStorage('Alice/A');
    await reg().markUnused('Alice/A');
    await reg().block('Alice/A');
    await reg().upsertRepo('alice', 'a');
    await reg().syncLinks('alice', 'a', new Set(['Alice/A']));
    const res = await reg().reconcileStorage();
    expect(res.becameUsed.map((s) => s.prefix)).toEqual(['Alice/A']);
    expect(res.blockedReused.map((s) => s.prefix)).toEqual(['Alice/A']);
    expect((await reg().getStorage('Alice/A'))?.status).toBe('used');
  });

  test('already used but still blocked → surfaced as blockedReused', async () => {
    await reg().upsertRepo('alice', 'a');
    await reg().upsertStorage('Alice/A');
    await reg().syncLinks('alice', 'a', new Set(['Alice/A']));
    await reg().block('Alice/A');
    const res = await reg().reconcileStorage();
    expect(res.blockedReused.map((s) => s.prefix)).toEqual(['Alice/A']);
  });

  test('purged prefix ignored', async () => {
    await reg().upsertStorage('alice/a');
    await reg().markUnused('alice/a');
    await reg().block('alice/a');
    await reg().markPurged('alice/a');
    const res = await reg().reconcileStorage();
    expect(res.becameUnused).toEqual([]);
    expect((await reg().getStorage('alice/a'))?.status).toBe('purged');
  });

  test('reconcileStoragePrefix handles a single prefix', async () => {
    await reg().upsertStorage('alice/a');
    const res = await reg().reconcileStoragePrefix('alice/a');
    expect(res.becameUnused.map((s) => s.prefix)).toEqual(['alice/a']);
  });
});

describe('purge gate + prefix lookup', () => {
  test('getStorageByPrefix matches case-insensitively', async () => {
    await reg().upsertStorage('Alice/MyRepo');
    expect((await reg().getStorageByPrefix('alice/myrepo'))?.prefix).toBe('Alice/MyRepo');
    expect(await reg().getStorageByPrefix('alice/other')).toBeNull();
  });

  test('storageInUse is true only while an active link ties it to an active repo', async () => {
    await reg().upsertStorage('Alice/A');
    expect(await reg().storageInUse('Alice/A')).toBe(false); // no link
    await reg().upsertRepo('alice', 'a');
    await reg().syncLinks('alice', 'a', new Set(['Alice/A']));
    expect(await reg().storageInUse('Alice/A')).toBe(true);
    await reg().markMissing('alice', 'a');
    expect(await reg().storageInUse('Alice/A')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// links — git↔prefix graph (N:N)
// ---------------------------------------------------------------------------

describe('syncLinks (upsert / stale / active)', () => {
  test('creates active rows, lowercased git key, ISO timestamps', async () => {
    await reg().syncLinks('Alice', 'Repo', new Set(['Alice/Repo']));
    const [row] = await reg().listLinksForRepo('alice', 'repo');
    expect(row.owner).toBe('alice');
    expect(row.repo).toBe('repo');
    expect(row.prefix).toBe('Alice/Repo');
    expect(row.status).toBe('active');
    expect(row.firstSeen).toMatch(ISO_RE);
    expect(row.lastSeen).toMatch(ISO_RE);
  });

  test('shared prefix → one link row per repo', async () => {
    await reg().syncLinks('alice', 'a', new Set(['shared/prefix']));
    await reg().syncLinks('bob', 'b', new Set(['shared/prefix']));
    const rows = await reg().listLinksForStorage('shared/prefix');
    expect(rows.map((r) => key(r.owner, r.repo)).sort()).toEqual(['alice/a', 'bob/b']);
  });

  test('one repo at two prefixes → two rows', async () => {
    await reg().syncLinks('alice', 'a', new Set(['alice/a', 'alice/a-mirror']));
    const rows = await reg().listLinksForRepo('alice', 'a');
    expect(rows.map((r) => r.prefix).sort()).toEqual(['alice/a', 'alice/a-mirror']);
    expect(rows.every((r) => r.status === 'active')).toBe(true);
  });

  test('dropping a prefix marks it stale; kept stays active, firstSeen preserved, lastSeen bumped', async () => {
    await reg().syncLinks('alice', 'a', new Set(['p1', 'p2']));
    const before = await reg().listLinksForRepo('alice', 'a');
    const p1Before = before.find((r) => r.prefix === 'p1')!;
    await new Promise((r) => setTimeout(r, 1100));
    await reg().syncLinks('alice', 'a', new Set(['p1']));
    const after = await reg().listLinksForRepo('alice', 'a');
    const p1 = after.find((r) => r.prefix === 'p1')!;
    const p2 = after.find((r) => r.prefix === 'p2')!;
    expect(p1.status).toBe('active');
    expect(p2.status).toBe('stale');
    expect(p1.firstSeen).toBe(p1Before.firstSeen);
    expect(p1.lastSeen).not.toBe(p1Before.lastSeen);
  });

  test('empty prefix set marks every active link stale', async () => {
    await reg().syncLinks('alice', 'a', new Set(['p1', 'p2']));
    await reg().syncLinks('alice', 'a', new Set());
    const rows = await reg().listLinksForRepo('alice', 'a');
    expect(rows.every((r) => r.status === 'stale')).toBe(true);
  });

  test('re-syncing a stale prefix reactivates it', async () => {
    await reg().syncLinks('alice', 'a', new Set(['p1']));
    await reg().syncLinks('alice', 'a', new Set()); // p1 → stale
    await reg().syncLinks('alice', 'a', new Set(['p1'])); // back
    const [row] = await reg().listLinksForRepo('alice', 'a');
    expect(row.status).toBe('active');
  });
});

describe('staleLinksForRepo', () => {
  test('marks all of a repo’s active links stale, leaves other repos untouched', async () => {
    await reg().syncLinks('alice', 'a', new Set(['p1', 'p2']));
    await reg().syncLinks('bob', 'b', new Set(['p3']));
    await reg().staleLinksForRepo('Alice', 'A');
    expect((await reg().listLinksForRepo('alice', 'a')).every((r) => r.status === 'stale')).toBe(
      true,
    );
    expect((await reg().listLinksForRepo('bob', 'b')).every((r) => r.status === 'active')).toBe(
      true,
    );
  });
});

describe('listActiveLinks (purge gate)', () => {
  test('returns active links only from active git repos', async () => {
    await reg().upsertRepo('alice', 'a');
    await reg().syncLinks('alice', 'a', new Set(['shared/prefix']));
    expect((await reg().listActiveLinks('shared/prefix')).map((r) => key(r.owner, r.repo))).toEqual(
      ['alice/a'],
    );
  });

  test('excludes links whose git repo is missing', async () => {
    await reg().upsertRepo('alice', 'a');
    await reg().syncLinks('alice', 'a', new Set(['p']));
    await reg().markMissing('alice', 'a');
    expect(await reg().listActiveLinks('p')).toEqual([]);
  });

  test('excludes stale links and links with no repos row', async () => {
    await reg().syncLinks('ghost', 'g', new Set(['p'])); // no repos row
    expect(await reg().listActiveLinks('p')).toEqual([]);
    await reg().upsertRepo('alice', 'a');
    await reg().syncLinks('alice', 'a', new Set(['p']));
    await reg().syncLinks('alice', 'a', new Set()); // p → stale
    expect(await reg().listActiveLinks('p')).toEqual([]);
  });
});

describe('activeOp denormalization + upload tracking', () => {
  test('setActiveOp / endStorageOp round-trip', async () => {
    await reg().upsertStorage('alice/a');
    await reg().setActiveOp('alice/a', 'backup');
    expect((await reg().getStorage('alice/a'))?.activeOp).toBe('backup');
    await reg().block('alice/a');
    await reg().endStorageOp('alice/a', 'purged');
    const row = await reg().getStorage('alice/a');
    expect(row?.status).toBe('purged');
    expect(row?.activeOp).toBeNull();
    expect(row?.purgedAt).not.toBeNull();
  });

  test('recordUpload bumps lastChangeAt + resets backupComplete', async () => {
    await reg().upsertStorage('alice/a');
    await reg().recordUpload('alice/a');
    const row = await reg().getStorage('alice/a');
    expect(row?.lastChangeAt).toMatch(ISO_RE);
    expect(row?.backupComplete).toBe(false);
  });
});

describe('endBackup (cold copy outcome)', () => {
  test('blocked under the same archivedAt throughout → backupComplete true, status untouched', async () => {
    await reg().upsertStorage('alice/a');
    await reg().markUnused('alice/a');
    const blocked = await reg().block('alice/a');
    await reg().endBackup('alice/a', blocked!.archivedAt);
    const row = await reg().getStorage('alice/a');
    expect(row?.backedUpAt).toMatch(ISO_RE);
    expect(row?.backupComplete).toBe(true);
    expect(row?.status).toBe('unused'); // BackUp never moves resting status
    expect(row?.activeOp).toBeNull();
  });

  test('started unblocked (archivedAt null at start) → cold copy exists but incomplete', async () => {
    await reg().upsertStorage('alice/a');
    await reg().endBackup('alice/a', null);
    const row = await reg().getStorage('alice/a');
    expect(row?.backedUpAt).toMatch(ISO_RE);
    expect(row?.backupComplete).toBe(false);
  });

  test('unblocked mid-run (archivedAt changed) → incomplete', async () => {
    await reg().upsertStorage('alice/a');
    const blocked = await reg().block('alice/a');
    await reg().unblock('alice/a'); // archivedAt cleared mid-backup
    await reg().endBackup('alice/a', blocked!.archivedAt);
    expect((await reg().getStorage('alice/a'))?.backupComplete).toBe(false);
  });
});

describe('endDeleteBackup (cold copy dropped)', () => {
  test('clears backedUpAt/backupComplete/activeOp, status + archivedAt untouched', async () => {
    await reg().upsertStorage('alice/a');
    await reg().markUnused('alice/a');
    const blocked = await reg().block('alice/a');
    await reg().endBackup('alice/a', blocked!.archivedAt); // backedUpAt + backupComplete set
    await reg().setActiveOp('alice/a', 'deleteBackup');

    await reg().endDeleteBackup('alice/a');

    const row = await reg().getStorage('alice/a');
    expect(row?.backedUpAt).toBeNull();
    expect(row?.backupComplete).toBe(false);
    expect(row?.activeOp).toBeNull();
    expect(row?.status).toBe('unused'); // Delete Backup never moves resting status
    expect(row?.archivedAt).toBe(blocked!.archivedAt); // live R2 untouched, still blocked
  });
});

describe('endRestore (cold restore outcome)', () => {
  test('clears archivedAt/clearedAt/backupComplete/activeOp, keeps backedUpAt, status untouched', async () => {
    await reg().upsertStorage('alice/a');
    await reg().markUnused('alice/a');
    const blocked = await reg().block('alice/a');
    await reg().endBackup('alice/a', blocked!.archivedAt); // backedUpAt + backupComplete set
    await reg().setActiveOp('alice/a', 'restore');

    await reg().endRestore('alice/a');

    const row = await reg().getStorage('alice/a');
    expect(row?.status).toBe('unused'); // Restore never moves resting status
    expect(row?.archivedAt).toBeNull();
    expect(row?.clearedAt).toBeNull();
    expect(row?.backupComplete).toBe(false);
    expect(row?.activeOp).toBeNull();
    expect(row?.backedUpAt).toMatch(ISO_RE); // cold copy still exists
  });
});

describe('endClear (live cleared, cold copy kept)', () => {
  test('clears activeOp only; status/archivedAt/clearedAt/backupComplete untouched', async () => {
    await reg().upsertStorage('alice/a');
    await reg().markUnused('alice/a');
    const blocked = await reg().block('alice/a');
    await reg().endBackup('alice/a', blocked!.archivedAt); // backedUpAt + backupComplete set
    const cleared = await reg().markCleared('alice/a'); // clearedAt stamped at workflow start
    await reg().setActiveOp('alice/a', 'clear');

    await reg().endClear('alice/a');

    const row = await reg().getStorage('alice/a');
    expect(row?.activeOp).toBeNull();
    expect(row?.status).toBe('unused'); // Clear never moves resting status
    expect(row?.archivedAt).toBe(blocked!.archivedAt); // still blocked
    expect(row?.clearedAt).toBe(cleared!.clearedAt); // stamped at start, untouched
    expect(row?.backupComplete).toBe(true); // cold copy intact
    expect(row?.backedUpAt).toMatch(ISO_RE);
  });
});

// ---------------------------------------------------------------------------
// orgs
// ---------------------------------------------------------------------------

describe('upsertOrgStatus / listOrgs', () => {
  test('insert active → no missing_at; insert missing → missing_at', async () => {
    expect((await reg().upsertOrgStatus('Alice', 'active')).missingAt).toBeNull();
    expect((await reg().upsertOrgStatus('bob', 'missing')).missingAt).toMatch(ISO_RE);
  });

  test('consecutive missing preserves missing_at', async () => {
    const a = await reg().upsertOrgStatus('alice', 'missing');
    await new Promise((r) => setTimeout(r, 1100));
    const b = await reg().upsertOrgStatus('alice', 'missing');
    expect(b.missingAt).toBe(a.missingAt);
  });

  test('missing → active clears missing_at + last_error', async () => {
    await reg().upsertOrgStatus('alice', 'missing', '404');
    const row = await reg().upsertOrgStatus('alice', 'active');
    expect(row.missingAt).toBeNull();
    expect(row.lastError).toBeNull();
  });

  test('listOrgs returns all rows', async () => {
    await reg().upsertOrgStatus('a', 'active');
    await reg().upsertOrgStatus('b', 'missing');
    expect((await reg().listOrgs()).map((r) => r.org).sort()).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// live updates — WebSocket push on every storage write
// ---------------------------------------------------------------------------

describe('live updates (/api/live WebSocket)', () => {
  async function openLive() {
    const res = await reg().fetch(
      new Request('https://x/api/live', { headers: { Upgrade: 'websocket' } }),
    );
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    return ws;
  }

  const nextTick = (ws: WebSocket) =>
    new Promise<string>((resolve) =>
      ws.addEventListener('message', (e) => resolve(e.data as string), { once: true }),
    );

  test('non-upgrade request → 426', async () => {
    const res = await reg().fetch(new Request('https://x/api/live'));
    expect(res.status).toBe(426);
  });

  test('a storage write pushes a "storage" tick to a connected client', async () => {
    const ws = await openLive();
    const tick = nextTick(ws);
    await reg().upsertStorage('alice/a'); // new prefix → broadcast
    expect(await tick).toBe('storage');
  });

  test('a repo write pushes a "repos" tick', async () => {
    const ws = await openLive();
    const tick = nextTick(ws);
    await reg().upsertRepo('alice', 'a'); // new repo → broadcast
    expect(await tick).toBe('repos');
  });

  test('a repo status change pushes a "repos" tick', async () => {
    await reg().upsertRepo('alice', 'a');
    const ws = await openLive();
    const tick = nextTick(ws);
    await reg().markMissing('alice', 'a'); // updateRepo row changed → broadcast
    expect(await tick).toBe('repos');
  });

  test('a no-op repo re-upsert does not push', async () => {
    await reg().upsertRepo('alice', 'a'); // first insert
    const ws = await openLive();
    let pushed = false;
    ws.addEventListener('message', () => (pushed = true));
    await reg().upsertRepo('alice', 'a'); // conflict → only bumps updatedAt, no broadcast
    await new Promise((r) => setTimeout(r, 200));
    expect(pushed).toBe(false);
  });

  test('a lifecycle change pushes a tick', async () => {
    await reg().upsertStorage('alice/a');
    const ws = await openLive();
    const tick = nextTick(ws);
    await reg().markUnused('alice/a'); // updateStorage row changed → broadcast
    expect(await tick).toBe('storage');
  });

  test('a no-op write (re-upsert) does not push', async () => {
    await reg().upsertStorage('alice/a'); // first insert
    const ws = await openLive();
    let pushed = false;
    ws.addEventListener('message', () => (pushed = true));
    await reg().upsertStorage('alice/a'); // conflict → only bumps updatedAt, no broadcast
    await new Promise((r) => setTimeout(r, 200));
    expect(pushed).toBe(false);
  });
});

describe('isolation', () => {
  test('different idFromName → separate state', async () => {
    const a = env.REGISTRY.get(env.REGISTRY.idFromName('a'));
    const b = env.REGISTRY.get(env.REGISTRY.idFromName('b'));
    await a.upsertStorage('alice/repo');
    expect(await b.getStorage('alice/repo')).toBeNull();
  });
});
