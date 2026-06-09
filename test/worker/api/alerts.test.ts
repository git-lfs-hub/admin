import { reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test } from 'vitest';

import alertsApp from '@/api/alerts';

afterEach(async () => {
  await reset();
});

const a = () => env.ALERTS.getByName('global');
const get = () => alertsApp.request('/', {}, env);

async function body() {
  const res = await get();
  expect(res.status).toBe(200);
  return res.json<{
    alerts: { kind: string; scope: string }[];
    slackError: { message: string } | null;
  }>();
}

describe('GET /api/alerts', () => {
  test('empty when nothing is tracked', async () => {
    expect(await body()).toEqual({ alerts: [], slackError: null });
  });

  test('returns storage alerts, sorted by updatedAt descending', async () => {
    await a().sendNotification({ kind: 'missing', scope: 'a/one' });
    await new Promise((r) => setTimeout(r, 1100));
    await a().sendNotification({ kind: 'archived', scope: 'a/two' });
    const { alerts } = await body();
    expect(alerts.map((x) => `${x.scope}:${x.kind}`)).toEqual(['a/two:archived', 'a/one:missing']);
  });

  test('partitions the system:slack health row out of alerts into slackError', async () => {
    await a().sendNotification({ kind: 'missing', scope: 'a/one' });
    await a().recordSlackError('not_in_channel');
    const { alerts, slackError } = await body();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].scope).toBe('a/one');
    expect(slackError).toMatchObject({ message: 'not_in_channel' });
  });
});
