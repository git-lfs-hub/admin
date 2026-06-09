import { describe, expect, test, vi } from 'vitest';

import { deliverSlack, notificationBlocks, type SlackStore } from '@/alerts/slack';

type AlertRow = Parameters<typeof notificationBlocks>[1];

const alert: AlertRow = {
  kind: 'missing',
  scope: 'alice/repo',
  severity: 'warning',
  detail: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
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
  test('section copy + an Open-in-admin url button', () => {
    const blocks = notificationBlocks(envWith('xoxb', 'C1'), alert) as any[];
    expect(blocks[0].text.text).toContain('alice/repo');
    const button = blocks[1].elements[0];
    expect(button.type).toBe('button');
    expect(button.url).toContain('/storage?highlight=alice%2Frepo');
  });
});
