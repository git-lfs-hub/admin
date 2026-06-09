import { SlackAPIClient } from 'slack-web-api-client';

import { adminLink, alertCopy } from '@/alerts/message';
import { alerts, type AlertKind } from '@/db/alerts-schema';
import { isoNow } from '@/lib/time';

type AlertRow = typeof alerts.$inferSelect;

// One delivery per scope; `kind` is the state currently shown in that Slack message.
export type SlackDelivery = { kind: string; sentAt: string; channel: string; ts: string };

/** The slice of the ALERTS DO `deliverSlack` uses: per-scope delivery rows + global health
 *  (so a misconfig surfaces in-app rather than only in logs). */
export interface SlackStore {
  getSlackDelivery(scope: string): Promise<SlackDelivery | null>;
  recordSlackDelivery(scope: string, delivery: SlackDelivery): Promise<void>;
  recordSlackError(message: string): Promise<void>;
  clearSlackError(): Promise<void>;
}

export type SlackResult = { status: 'sent' | 'skipped' } | { status: 'failed'; error: string };

/** Slice of `SlackAPIClient` we use, so tests can inject a fake. */
export interface SlackPoster {
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      blocks?: unknown[];
    }): Promise<{ channel?: string; ts?: string }>;
    update(args: {
      channel: string;
      ts: string;
      text: string;
      blocks?: unknown[];
    }): Promise<unknown>;
  };
}

/**
 * One Slack message per scope: first state posts, later states `chat.update` it in place (so a
 * prefix's missing → archived → restored is one updating message). `skipped` when unconfigured
 * or the shown state hasn't changed. A Slack API error (bad token, bot not in channel, …) is
 * NOT thrown — it's recorded to the global health store (`failed`) and cleared on success, so a
 * misconfig shows up in the admin UI instead of dying in a log line.
 */
export async function deliverSlack(
  env: CloudflareBindings,
  store: SlackStore,
  alert: AlertRow,
  poster?: SlackPoster,
): Promise<SlackResult> {
  const channel = env.ADMIN.slack.channel;
  if (!env.SLACK_BOT_TOKEN || !channel) return { status: 'skipped' };

  const existing = await store.getSlackDelivery(alert.scope);
  if (existing && existing.kind === alert.kind) return { status: 'skipped' }; // already shown

  const client: SlackPoster = poster ?? new SlackAPIClient(env.SLACK_BOT_TOKEN);
  const copy = alertCopy(alert.kind as AlertKind, alert.scope);
  const text = `${copy.emoji} ${copy.text}`;
  const blocks = notificationBlocks(env, alert);
  try {
    let ts: string;
    let msgChannel: string;
    if (existing) {
      await client.chat.update({ channel: existing.channel, ts: existing.ts, text, blocks });
      ts = existing.ts;
      msgChannel = existing.channel;
    } else {
      const res = await client.chat.postMessage({ channel, text, blocks });
      ts = res.ts ?? '';
      msgChannel = res.channel ?? channel;
    }
    await store.recordSlackDelivery(alert.scope, {
      kind: alert.kind,
      sentAt: isoNow(),
      channel: msgChannel,
      ts,
    });
    await store.clearSlackError();
    return { status: 'sent' };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[alerts] Slack delivery failed (${alert.scope}/${alert.kind}): ${error}`);
    await store.recordSlackError(error);
    return { status: 'failed', error };
  }
}

export function notificationBlocks(env: CloudflareBindings, alert: AlertRow): unknown[] {
  const copy = alertCopy(alert.kind as AlertKind, alert.scope);
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${copy.emoji} ${copy.text}` },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open in admin' },
          url: adminLink(env.ADMIN.url, alert.scope),
        },
      ],
    },
  ];
}
