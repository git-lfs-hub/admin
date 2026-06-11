import { hexToBytes } from '@git-lfs-hub/lib/crypto';
import { SlackAPIClient } from 'slack-web-api-client';

import { adminLink, alertCopy, encodeAction, notifyActionFor } from '@/alerts/message';
import { alerts, isConfirmKind, type AlertKind } from '@/db/alerts-schema';
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
  const blocks = blocksFor(env, alert);
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

// Confirm kinds get Confirm/Cancel buttons; notify kinds get the plain Open-in-admin block.
function blocksFor(env: CloudflareBindings, alert: AlertRow): unknown[] {
  return isConfirmKind(alert.kind)
    ? confirmationBlocks(env, alert)
    : notificationBlocks(env, alert);
}

const openButton = (env: CloudflareBindings, alert: AlertRow) => ({
  type: 'button',
  text: { type: 'plain_text', text: 'Open in admin' },
  url: adminLink(env.ADMIN.url, alert.scope),
});

// State line, then — for a kind with a default action (missing → Archive, archived → Restore) —
// the action's consequence copy + its button. Recovery kinds show only Open-in-admin.
export function notificationBlocks(env: CloudflareBindings, alert: AlertRow): unknown[] {
  const copy = alertCopy(alert.kind as AlertKind, alert.scope);
  const action = notifyActionFor(alert.kind);
  const section = { type: 'section', text: { type: 'mrkdwn', text: `${copy.emoji} ${copy.text}` } };
  if (!action) return [section, { type: 'actions', elements: [openButton(env, alert)] }];
  return [
    section,
    context(action.consequence),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: action.label },
          action_id: action.verb,
          value: encodeAction(alert.scope, alert.kind),
        },
        openButton(env, alert),
      ],
    },
  ];
}

// Pending → Confirm/Cancel buttons; decided → a status line (buttons drop).
export function confirmationBlocks(env: CloudflareBindings, alert: AlertRow): unknown[] {
  const copy = alertCopy(alert.kind as AlertKind, alert.scope);
  const section = { type: 'section', text: { type: 'mrkdwn', text: `${copy.emoji} ${copy.text}` } };

  if (alert.decision === 'approve')
    return [section, context(`✅ Confirmed by ${alert.decidedBy ?? 'admin'}`)];
  if (alert.decision === 'cancel')
    return [section, context(`⏸️ Cancelled by ${alert.decidedBy ?? 'admin'} — resume in admin`)];

  const value = encodeAction(alert.scope, alert.kind);
  return [
    section,
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: `Confirm ${alert.kind}` },
          action_id: 'approve',
          value,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Cancel' },
          action_id: 'cancel',
          value,
        },
        openButton(env, alert),
      ],
    },
  ];
}

const context = (text: string) => ({
  type: 'context',
  elements: [{ type: 'mrkdwn', text }],
});

// Force a chat.update after approve/cancel: the shown `kind` is unchanged, so `deliverSlack`'s
// same-kind skip would no-op. No-op when Slack is off or no message exists for the scope.
export async function refreshConfirmation(
  env: CloudflareBindings,
  store: SlackStore,
  alert: AlertRow,
  poster?: SlackPoster,
): Promise<void> {
  if (!env.SLACK_BOT_TOKEN) return;
  const existing = await store.getSlackDelivery(alert.scope);
  if (!existing) return;
  const copy = alertCopy(alert.kind as AlertKind, alert.scope);
  const client: SlackPoster = poster ?? new SlackAPIClient(env.SLACK_BOT_TOKEN);
  try {
    await client.chat.update({
      channel: existing.channel,
      ts: existing.ts,
      text: `${copy.emoji} ${copy.text}`,
      blocks: confirmationBlocks(env, alert),
    });
    await store.clearSlackError();
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[alerts] Slack refresh failed (${alert.scope}/${alert.kind}): ${error}`);
    await store.recordSlackError(error);
  }
}

// Verify an inbound Slack request: `v0=HMAC_SHA256(secret, "v0:{ts}:{body}")`, hex. Reject stale
// timestamps (>5 min) for replay; fail closed on malformed input. `crypto.subtle.verify` is
// constant-time. https://api.slack.com/authentication/verifying-requests-from-slack
export async function verifySlackRequest(
  secret: string | undefined,
  timestamp: string | undefined,
  signature: string | undefined,
  body: string,
  nowSec: number,
): Promise<boolean> {
  if (!secret || !timestamp || !signature?.startsWith('v0=')) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 300) return false;
  const provided = hexToBytes(signature.slice('v0='.length));
  if (!provided) return false;

  const encoder = new TextEncoder();
  const algo = { name: 'HMAC', hash: 'SHA-256' };
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), algo, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, provided, encoder.encode(`v0:${timestamp}:${body}`));
}
