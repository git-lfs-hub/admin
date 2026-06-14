import { describe, expect, test, vi } from 'vitest';

import {
  confirmationBlocks,
  deliverSlack,
  notificationBlocks,
  refreshConfirmation,
  verifySlackRequest,
  type SlackStore,
} from '@/alerts/slack';

type AlertRow = Parameters<typeof notificationBlocks>[1];

const alert: AlertRow = {
  kind: 'missing',
  scope: 'alice/repo',
  severity: 'warning',
  detail: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  decision: null,
  decidedAt: null,
  decidedBy: null,
};

type Existing = { kind: string; channel: string; ts: string } | null;

function fakeStore(existing: Existing = null): SlackStore & {
  record: ReturnType<typeof vi.fn>;
  recordSlackError: ReturnType<typeof vi.fn>;
  clearSlackError: ReturnType<typeof vi.fn>;
} {
  const record = vi.fn(async () => {});
  return {
    record,
    getSlackDelivery: vi.fn(async () => (existing ? { sentAt: 't', ...existing } : null)),
    recordSlackDelivery: record,
    recordSlackError: vi.fn(async () => {}),
    clearSlackError: vi.fn(async () => {}),
  };
}

function fakePoster() {
  return {
    chat: {
      postMessage: vi.fn(async () => ({ channel: 'C9', ts: '99.1' })),
      update: vi.fn(async () => ({})),
    },
  };
}

function envWith(token: string, channel: string): CloudflareBindings {
  return {
    SLACK_BOT_TOKEN: token,
    ADMIN: { slack: { channel }, url: 'https://admin.example' },
  } as unknown as CloudflareBindings;
}

describe('deliverSlack', () => {
  test('skipped when token is empty (never posts or records)', async () => {
    const store = fakeStore();
    const poster = fakePoster();
    const res = await deliverSlack(envWith('', 'C1'), store, alert, poster);
    expect(res).toEqual({ status: 'skipped' });
    expect(poster.chat.postMessage).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
  });

  test('skipped when channel is empty', async () => {
    const store = fakeStore();
    const poster = fakePoster();
    const res = await deliverSlack(envWith('xoxb', ''), store, alert, poster);
    expect(res).toEqual({ status: 'skipped' });
    expect(poster.chat.postMessage).not.toHaveBeenCalled();
  });

  test('skips when the message already shows this state (same kind)', async () => {
    const store = fakeStore({ kind: 'missing', channel: 'C', ts: '1' });
    const poster = fakePoster();
    const res = await deliverSlack(envWith('xoxb', 'C1'), store, alert, poster);
    expect(res).toEqual({ status: 'skipped' });
    expect(poster.chat.postMessage).not.toHaveBeenCalled();
    expect(poster.chat.update).not.toHaveBeenCalled();
  });

  test('first state → posts a new message, records (kind, ts), clears health', async () => {
    const store = fakeStore();
    const poster = fakePoster();
    const res = await deliverSlack(envWith('xoxb', 'C1'), store, alert, poster);
    expect(poster.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C1', text: expect.stringContaining('alice/repo') }),
    );
    expect(res).toEqual({ status: 'sent' });
    expect(store.record).toHaveBeenCalledWith(
      'alice/repo',
      expect.objectContaining({ kind: 'missing', ts: '99.1' }),
    );
    expect(store.clearSlackError).toHaveBeenCalled();
  });

  test('state change → chat.update in place (same ts/channel), no new post', async () => {
    const store = fakeStore({ kind: 'missing', channel: 'C7', ts: '42.0' });
    const poster = fakePoster();
    const res = await deliverSlack(
      envWith('xoxb', 'C1'),
      store,
      { ...alert, kind: 'archived' },
      poster,
    );
    expect(poster.chat.postMessage).not.toHaveBeenCalled();
    expect(poster.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C7',
        ts: '42.0',
        text: expect.stringContaining('archived'),
      }),
    );
    expect(res).toEqual({ status: 'sent' });
    expect(store.record).toHaveBeenCalledWith(
      'alice/repo',
      expect.objectContaining({ kind: 'archived', ts: '42.0', channel: 'C7' }),
    );
  });

  test('Slack API error is recorded to health, not thrown', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = fakeStore();
    const poster = fakePoster();
    poster.chat.postMessage.mockRejectedValueOnce(new Error('not_in_channel'));
    const res = await deliverSlack(envWith('xoxb', 'C1'), store, alert, poster);
    expect(res).toEqual({ status: 'failed', error: 'not_in_channel' });
    expect(store.record).not.toHaveBeenCalled();
    expect(store.recordSlackError).toHaveBeenCalledWith('not_in_channel');
  });
});

describe('notificationBlocks', () => {
  test('actionable kind → consequence copy + default-action button (scope#kind) + Open-in-admin', () => {
    const [section, consequence, actions] = notificationBlocks(envWith('xoxb', 'C1'), {
      ...alert,
      scope: 'storage:alice/repo',
    }) as any[];
    expect(section.text.text).toContain('alice/repo');
    expect(consequence.type).toBe('context');
    expect(consequence.elements[0].text).toContain('Stops this storage');
    const [act, open] = actions.elements;
    expect(act.action_id).toBe('archive');
    expect(act.value).toBe('storage:alice/repo#missing');
    expect(open.url).toContain('/storage?highlight=alice%2Frepo');
  });

  test('recovery kind → only Open-in-admin, no consequence or action button', () => {
    const blocks = notificationBlocks(envWith('xoxb', 'C1'), {
      ...alert,
      kind: 'restored',
    }) as any[];
    expect(blocks).toHaveLength(2);
    expect(blocks[1].elements).toHaveLength(1);
    expect(blocks[1].elements[0].url).toContain('/storage?highlight=');
  });
});

const purge: AlertRow = { ...alert, kind: 'purge', scope: 'storage:alice/repo' };

describe('confirmationBlocks', () => {
  test('pending → Confirm/Cancel buttons carrying scope#kind', () => {
    const [, actions] = confirmationBlocks(envWith('xoxb', 'C1'), purge) as any[];
    const ids = actions.elements.map((e: any) => e.action_id);
    expect(ids).toEqual(['approve', 'cancel', undefined]); // third is the url button
    expect(actions.elements[0].value).toBe('storage:alice/repo#purge');
  });

  test('decided → status line, no buttons', () => {
    const approved = confirmationBlocks(envWith('xoxb', 'C1'), {
      ...purge,
      decision: 'approve',
      decidedBy: 'slack:u',
    }) as any[];
    expect(approved).toHaveLength(2);
    expect(approved[1].type).toBe('context');
    expect(approved[1].elements[0].text).toContain('slack:u');

    const cancelled = confirmationBlocks(envWith('xoxb', 'C1'), {
      ...purge,
      decision: 'cancel',
      decidedBy: 'slack:u',
    }) as any[];
    expect(cancelled[1].elements[0].text).toContain('Cancelled');
  });
});

describe('refreshConfirmation', () => {
  test('chat.updates the existing message in place', async () => {
    const store = fakeStore({ kind: 'purge', channel: 'C7', ts: '5.0' });
    const poster = fakePoster();
    await refreshConfirmation(
      envWith('xoxb', 'C1'),
      store,
      { ...purge, decision: 'approve' },
      poster,
    );
    expect(poster.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C7', ts: '5.0' }),
    );
  });

  test('no-op when no message was ever posted for the scope', async () => {
    const store = fakeStore(null);
    const poster = fakePoster();
    await refreshConfirmation(envWith('xoxb', 'C1'), store, purge, poster);
    expect(poster.chat.update).not.toHaveBeenCalled();
  });
});

describe('verifySlackRequest', () => {
  const secret = 'shhh';
  const body = 'payload=%7B%7D';

  async function sign(ts: string, b: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${ts}:${b}`));
    const hex = [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `v0=${hex}`;
  }

  test('valid signature within the freshness window → true', async () => {
    const ts = '1000';
    expect(await verifySlackRequest(secret, ts, await sign(ts, body), body, 1010)).toBe(true);
  });

  test('tampered body → false', async () => {
    const ts = '1000';
    const good = await sign(ts, body);
    expect(await verifySlackRequest(secret, ts, good, 'payload=%7B%22x%22%3A1%7D', 1010)).toBe(
      false,
    );
  });

  test('stale timestamp (>5 min) → false', async () => {
    const ts = '1000';
    expect(await verifySlackRequest(secret, ts, await sign(ts, body), body, 2000)).toBe(false);
  });

  test('missing secret / bad signature shape → false', async () => {
    expect(await verifySlackRequest('', '1000', 'v0=ab', body, 1000)).toBe(false);
    expect(await verifySlackRequest(secret, '1000', 'nope', body, 1000)).toBe(false);
    expect(await verifySlackRequest(secret, undefined, 'v0=ab', body, 1000)).toBe(false);
  });
});
