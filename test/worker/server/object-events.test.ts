import { reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, test, expect, afterEach } from 'vitest';

import { handleObjectEvents, type ObjectEvent } from '@/server/object-events';

afterEach(async () => {
  await reset();
});

const reg = () => env.REGISTRY.getByName('global');

function evt(over: Partial<ObjectEvent> = {}): ObjectEvent {
  return {
    owner: 'alice',
    repo: 'thing',
    oid: 'abc',
    size: 10,
    operation: 'upload',
    ...over,
  };
}

function makeBatch(events: ObjectEvent[]): MessageBatch<ObjectEvent> {
  return {
    queue: 'lfs-object-events',
    messages: events.map((e, i) => ({
      id: `m-${i}`,
      timestamp: new Date(),
      body: e,
      attempts: 1,
      ack: () => {},
      retry: () => {},
    })),
    ackAll: () => {},
    retryAll: () => {},
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
  } as MessageBatch<ObjectEvent>;
}

describe('handleObjectEvents', () => {
  test('creates a storage row on first message', async () => {
    await handleObjectEvents(makeBatch([evt()]), env);
    const row = await reg().getStorage('alice/thing');
    expect(row?.status).toBe('pending'); // upload presigned, bytes not yet confirmed present
    expect(row?.firstSeen).toMatch(/^\d{4}/);
  });

  test('duplicate batches preserve firstSeen, advance updatedAt', async () => {
    await handleObjectEvents(makeBatch([evt()]), env);
    const a = await reg().getStorage('alice/thing');
    await new Promise((r) => setTimeout(r, 1100));
    await handleObjectEvents(makeBatch([evt()]), env);
    const b = await reg().getStorage('alice/thing');
    expect(b?.firstSeen).toBe(a?.firstSeen);
    expect(b?.updatedAt).not.toBe(a?.updatedAt);
  });

  test('an upload bumps recordUpload (lastChangeAt set, backupComplete false)', async () => {
    await handleObjectEvents(makeBatch([evt({ operation: 'upload' })]), env);
    const row = await reg().getStorage('alice/thing');
    expect(row?.lastChangeAt).toMatch(/^\d{4}/);
    expect(row?.backupComplete).toBe(false);
  });

  test('a non-upload batch leaves lastChangeAt null', async () => {
    await handleObjectEvents(makeBatch([evt({ operation: 'download' })]), env);
    expect((await reg().getStorage('alice/thing'))?.lastChangeAt).toBeNull();
  });

  test('empty batch is no-op', async () => {
    await handleObjectEvents(makeBatch([]), env);
    expect(await reg().listStorage()).toEqual([]);
  });

  test('op variants all upsert a storage row; confirmed ops land used, upload stays pending', async () => {
    await handleObjectEvents(
      makeBatch([
        evt({ repo: 'a', operation: 'upload' }),
        evt({ repo: 'b', operation: 'verify' }),
        evt({ repo: 'c', operation: 'download' }),
      ]),
      env,
    );
    expect((await reg().getStorage('alice/a'))?.status).toBe('pending'); // bytes unconfirmed
    expect((await reg().getStorage('alice/b'))?.status).toBe('used');
    expect((await reg().getStorage('alice/c'))?.status).toBe('used');
  });

  test('dedupes per-prefix across messages in one batch', async () => {
    await handleObjectEvents(
      makeBatch([evt({ oid: 'o1' }), evt({ oid: 'o2' }), evt({ oid: 'o3' })]),
      env,
    );
    const rows = await reg().listStorage();
    expect(rows.length).toBe(1);
  });

  test('records each object with its size into the storage index', async () => {
    await handleObjectEvents(
      makeBatch([
        evt({ oid: 'o1', size: 10 }),
        evt({ oid: 'o2', size: 25 }),
        evt({ repo: 'other', oid: 'o3', size: 5 }),
      ]),
      env,
    );
    const thing = await env.STORAGE.getByName('alice/thing').listObjects();
    expect(thing.map((o) => [o.oid, o.size]).sort()).toEqual([
      ['o1', 10],
      ['o2', 25],
    ]);
    const other = await env.STORAGE.getByName('alice/other').listObjects();
    expect(other.map((o) => [o.oid, o.size])).toEqual([['o3', 5]]);
  });
});
