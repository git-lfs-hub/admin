import { afterEach, describe, expect, test, vi } from 'vitest';

import { s3DeleteObject } from '@/s3/delete';

function env() {
  return {
    S3: { backup: { region: 'us-east-1', bucket: 'cold-bucket' } },
    S3_BACKUP_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    S3_BACKUP_SECRET_ACCESS_KEY: 'secret',
  } as unknown as CloudflareBindings;
}

afterEach(() => vi.restoreAllMocks());

describe('s3DeleteObject', () => {
  test('DELETEs the object key', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    await s3DeleteObject(env(), 'A/R/o1');
    const req = spy.mock.calls[0][0] as Request;
    expect(req.method).toBe('DELETE');
    expect(new URL(req.url).pathname).toBe('/cold-bucket/A/R/o1');
  });

  test('404 (already gone) → no-op, idempotent resume', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    await expect(s3DeleteObject(env(), 'A/R/o1')).resolves.toBeUndefined();
  });

  test('other failure → throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
    await expect(s3DeleteObject(env(), 'A/R/o1')).rejects.toThrow(/DeleteObject/);
  });
});
