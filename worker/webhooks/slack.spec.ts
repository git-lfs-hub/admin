import { beforeEach, describe, expect, test, vi } from 'vitest';

const { decide, wakeConfirmation, storageForRepo, archive, restore } = vi.hoisted(() => ({
  decide: vi.fn(async () => ({ ok: true })),
  wakeConfirmation: vi.fn(async () => {}),
  storageForRepo: vi.fn(async () => null as any),
  archive: vi.fn(async () => ({})),
  restore: vi.fn(async () => ({})),
}));
vi.mock('@/db/alerts', () => ({
  Alerts: { global: () => ({ decide }) },
  isDecision: (s: string) => s === 'approve' || s === 'cancel',
}));
vi.mock('@/workflows/confirm', () => ({ wakeConfirmation }));
vi.mock('@/db/registry', () => ({ Registry: { global: () => ({ storageForRepo }) } }));
vi.mock('@/server/operations', () => ({ archive, restore }));

import app from '@/webhooks/index';

const SECRET = 'sign-secret';
const env = { SLACK_SIGNING_SECRET: SECRET } as any;

async function sign(ts: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${ts}:${body}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `v0=${hex}`;
}

function payload(action_id: string, value: string): string {
  const body = JSON.stringify({ actions: [{ action_id, value }], user: { username: 'dana' } });
  return `payload=${encodeURIComponent(body)}`;
}

async function post(body: string, opts: { ts?: string; sig?: string } = {}) {
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const sig = opts.sig ?? (await sign(ts, body));
  return app.request(
    '/slack/interactions',
    {
      method: 'POST',
      headers: { 'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': sig },
      body,
    },
    env,
  );
}

beforeEach(() => {
  decide.mockClear();
  wakeConfirmation.mockClear();
  storageForRepo.mockReset();
  archive.mockClear();
  restore.mockClear();
});

describe('POST /webhooks/slack/interactions', () => {
  test('valid Confirm → decide + wakes the workflow', async () => {
    const res = await post(payload('approve', 'storage:alice/repo#purge'));
    expect(res.status).toBe(200);
    expect(decide).toHaveBeenCalledWith('storage:alice/repo', 'purge', 'approve', 'slack:dana');
    expect(wakeConfirmation).toHaveBeenCalledWith(
      expect.anything(),
      'storage:alice/repo',
      'purge',
      'approve',
      'slack:dana',
    );
  });

  test('valid Cancel → decide(..., cancel, ...)', async () => {
    const res = await post(payload('cancel', 'storage:alice/repo#purge'));
    expect(res.status).toBe(200);
    expect(decide).toHaveBeenCalledWith('storage:alice/repo', 'purge', 'cancel', 'slack:dana');
  });

  test('bad signature → 401, no dispatch', async () => {
    const body = payload('approve', 'storage:alice/repo#purge');
    const res = await post(body, { sig: 'v0=deadbeef' });
    expect(res.status).toBe(401);
    expect(decide).not.toHaveBeenCalled();
  });

  test('non-confirmation kind → 200 ack, no dispatch', async () => {
    const res = await post(payload('approve', 'storage:alice/repo#missing'));
    expect(res.status).toBe(200);
    expect(decide).not.toHaveBeenCalled();
  });

  test('Archive on a missing alert → archives the prefix', async () => {
    storageForRepo.mockResolvedValueOnce({
      prefix: 'alice/repo',
      status: 'unused',
      archivedAt: null,
    });
    const res = await post(payload('archive', 'storage:alice/repo#missing'));
    expect(res.status).toBe(200);
    expect(storageForRepo).toHaveBeenCalledWith('alice', 'repo');
    expect(archive).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'alice/repo');
    expect(restore).not.toHaveBeenCalled();
  });

  test('Restore on an archived alert → restores the prefix', async () => {
    storageForRepo.mockResolvedValueOnce({ prefix: 'alice/repo', status: 'used', archivedAt: 't' });
    const res = await post(payload('restore', 'storage:alice/repo#archived'));
    expect(res.status).toBe(200);
    expect(restore).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'alice/repo');
    expect(archive).not.toHaveBeenCalled();
  });

  test('stale Archive button on a now-live prefix → no-op (guarded)', async () => {
    storageForRepo.mockResolvedValueOnce({
      prefix: 'alice/repo',
      status: 'used',
      archivedAt: null,
    });
    const res = await post(payload('archive', 'storage:alice/repo#missing'));
    expect(res.status).toBe(200);
    expect(archive).not.toHaveBeenCalled();
  });

  test('a failing op is caught → still acks 200', async () => {
    storageForRepo.mockResolvedValueOnce({
      prefix: 'alice/repo',
      status: 'unused',
      archivedAt: null,
    });
    archive.mockRejectedValueOnce(new Error('rpc down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(payload('archive', 'storage:alice/repo#missing'));
    expect(res.status).toBe(200);
    expect(archive).toHaveBeenCalled();
  });
});
