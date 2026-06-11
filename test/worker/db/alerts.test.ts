import { reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test } from 'vitest';

afterEach(async () => {
  await reset();
});

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const a = () => env.ALERTS.getByName('global');

describe('sendNotification / getAlert', () => {
  test('persists one row per (scope, kind) with default severity from copy', async () => {
    const row = await a().sendNotification({ kind: 'missing', scope: 'alice/repo' });
    expect(row.kind).toBe('missing');
    expect(row.scope).toBe('alice/repo');
    expect(row.severity).toBe('warning');
    expect(row.createdAt).toMatch(ISO_RE);
    expect(await a().getAlert('alice/repo', 'missing')).toMatchObject({ scope: 'alice/repo' });
  });

  test('same kind, different scope → distinct rows', async () => {
    await a().sendNotification({ kind: 'missing', scope: 'a/one' });
    await a().sendNotification({ kind: 'missing', scope: 'a/two' });
    expect((await a().listAlerts()).length).toBe(2);
  });

  test('explicit severity overrides the default', async () => {
    const row = await a().sendNotification({
      kind: 'missing',
      scope: 'alice/repo',
      severity: 'info',
    });
    expect(row.severity).toBe('info');
  });

  test('re-send is idempotent: same row, no timestamp churn', async () => {
    const first = await a().sendNotification({ kind: 'archived', scope: 'alice/repo' });
    await new Promise((r) => setTimeout(r, 1100));
    const second = await a().sendNotification({ kind: 'archived', scope: 'alice/repo' });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(await a().listAlerts()).toHaveLength(1);
  });

  test('getAlert returns null when absent', async () => {
    expect(await a().getAlert('alice/repo', 'restored')).toBeNull();
  });
});

describe('clearAlert', () => {
  test('removes only the (scope, kind) row; no-op when absent', async () => {
    await a().sendNotification({ kind: 'missing', scope: 'alice/repo' });
    await a().sendNotification({ kind: 'archived', scope: 'alice/repo' });
    await a().clearAlert('alice/repo', 'missing');
    expect(await a().getAlert('alice/repo', 'missing')).toBeNull();
    expect(await a().getAlert('alice/repo', 'archived')).not.toBeNull();
    await a().clearAlert('alice/repo', 'missing'); // idempotent
  });
});

describe('Slack delivery (one message per scope, edited in place)', () => {
  test('sendNotification records no slack row when SLACK_BOT_TOKEN is empty', async () => {
    await a().sendNotification({ kind: 'missing', scope: 'alice/repo' });
    expect(await a().getSlackDelivery('alice/repo')).toBeNull();
  });

  test('recordSlackDelivery / getSlackDelivery roundtrip + upsert on scope (kind changes)', async () => {
    await a().recordSlackDelivery('alice/repo', {
      kind: 'missing',
      sentAt: 't1',
      channel: 'C',
      ts: '1',
    });
    expect(await a().getSlackDelivery('alice/repo')).toEqual({
      kind: 'missing',
      sentAt: 't1',
      channel: 'C',
      ts: '1',
    });
    // state change keeps the same message row (same scope), updates the shown kind
    await a().recordSlackDelivery('alice/repo', {
      kind: 'archived',
      sentAt: 't2',
      channel: 'C',
      ts: '1',
    });
    expect(await a().getSlackDelivery('alice/repo')).toEqual({
      kind: 'archived',
      sentAt: 't2',
      channel: 'C',
      ts: '1',
    });
  });

  test('clearAlert keeps the slack message row (next state updates it in place)', async () => {
    await a().sendNotification({ kind: 'missing', scope: 'alice/repo' });
    await a().recordSlackDelivery('alice/repo', {
      kind: 'missing',
      sentAt: 't',
      channel: 'C',
      ts: '1',
    });
    await a().clearAlert('alice/repo', 'missing');
    expect(await a().getSlackDelivery('alice/repo')).toMatchObject({ kind: 'missing', ts: '1' });
  });
});

describe('sendConfirmation / decide', () => {
  const scope = 'storage:alice/repo';

  test('fresh raise inserts a pending purge row', async () => {
    const row = await a().sendConfirmation({ kind: 'purge', scope });
    expect(row).toMatchObject({ kind: 'purge', scope, decision: null });
  });

  test('re-raise preserves an existing decision (no stale-approval reset)', async () => {
    await a().sendConfirmation({ kind: 'purge', scope });
    await a().decide(scope, 'purge', 'approve', 'slack:u1');
    const again = await a().sendConfirmation({ kind: 'purge', scope });
    expect(again.decision).toBe('approve');
    expect(again.decidedBy).toBe('slack:u1');
  });

  test('approve records actor; duplicate → already', async () => {
    await a().sendConfirmation({ kind: 'purge', scope });
    const first = await a().decide(scope, 'purge', 'approve', 'slack:u1');
    expect(first).toMatchObject({ ok: true });
    expect((await a().getAlert(scope, 'purge'))?.decidedBy).toBe('slack:u1');
    expect(await a().decide(scope, 'purge', 'approve', 'slack:u2')).toEqual({
      ok: false,
      reason: 'already',
    });
  });

  test('cancel sets the hold; duplicate → already', async () => {
    await a().sendConfirmation({ kind: 'purge', scope });
    expect(await a().decide(scope, 'purge', 'cancel', 'slack:u1')).toMatchObject({ ok: true });
    expect((await a().getAlert(scope, 'purge'))?.decision).toBe('cancel');
    expect(await a().decide(scope, 'purge', 'cancel', 'slack:u1')).toEqual({
      ok: false,
      reason: 'already',
    });
  });

  test('opposite decision overwrites (latest wins)', async () => {
    await a().sendConfirmation({ kind: 'purge', scope });
    await a().decide(scope, 'purge', 'approve', 'slack:u1');
    expect(await a().decide(scope, 'purge', 'cancel', 'slack:u2')).toMatchObject({ ok: true });
    expect((await a().getAlert(scope, 'purge'))?.decision).toBe('cancel');
  });

  test('decide on an absent alert → not_found', async () => {
    expect(await a().decide(scope, 'purge', 'approve', 'slack:u1')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('decideOrRaise', () => {
  const scope = 'storage:alice/repo';

  test('absent alert → recreates the confirmation then records the decision', async () => {
    const res = await a().decideOrRaise(scope, 'purge', 'approve', 'admin:dev');
    expect(res).toMatchObject({ ok: true });
    const row = await a().getAlert(scope, 'purge');
    expect(row).toMatchObject({ kind: 'purge', decision: 'approve', decidedBy: 'admin:dev' });
  });

  test('existing alert → decides without raising a duplicate row', async () => {
    await a().sendConfirmation({ kind: 'purge', scope });
    const res = await a().decideOrRaise(scope, 'purge', 'cancel', 'admin:dev');
    expect(res).toMatchObject({ ok: true });
    expect(await a().listAlerts()).toHaveLength(1);
    expect((await a().getAlert(scope, 'purge'))?.decision).toBe('cancel');
  });

  test('duplicate decision → already (no recreate)', async () => {
    await a().sendConfirmation({ kind: 'purge', scope });
    await a().decide(scope, 'purge', 'approve', 'admin:dev');
    expect(await a().decideOrRaise(scope, 'purge', 'approve', 'admin:dev')).toEqual({
      ok: false,
      reason: 'already',
    });
  });
});

describe('Slack delivery health (system:slack row)', () => {
  test('record / get / clear roundtrip', async () => {
    expect(await a().getSlackError()).toBeNull();
    await a().recordSlackError('not_in_channel');
    expect(await a().getSlackError()).toMatchObject({ message: 'not_in_channel' });
    await a().clearSlackError();
    expect(await a().getSlackError()).toBeNull();
  });

  test('the health row is a system-scoped alert, not a storage one', async () => {
    await a().recordSlackError('invalid_auth');
    const rows = await a().listAlerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: 'system:slack', detail: 'invalid_auth' });
  });
});
