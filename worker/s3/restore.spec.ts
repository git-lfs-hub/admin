import { afterEach, describe, expect, test, vi } from 'vitest';

import { copyObject } from '@/s3/copy';
import { r2Store } from '@/s3/r2-store';
import { s3NeedsThaw, s3Ready, s3RestoreObject } from '@/s3/restore';
import { s3Store } from '@/s3/s3-store';

// The restore direction (S3 → R2) of `copyObject`, exercised through the real stores so this covers
// the S3 store's reads + the R2 store's write/multipart paths (the inlined `copyS3toR2` workflow call).
const copyS3toR2 = (env: CloudflareBindings, key: string) =>
  copyObject(key, s3Store(env), r2Store(env));

const GiB = 1024 ** 3;

function env() {
  return {
    S3: { backup: { region: 'us-east-1', bucket: 'cold-bucket' } },
    S3_BACKUP_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    S3_BACKUP_SECRET_ACCESS_KEY: 'secret',
  } as unknown as CloudflareBindings;
}

afterEach(() => vi.restoreAllMocks());

function headResponse(headers: Record<string, string> = {}) {
  return new Response(null, { status: 200, headers });
}

// --- s3NeedsThaw ---

describe('s3NeedsThaw', () => {
  test.each([
    ['GLACIER', true],
    ['INTELLIGENT_TIERING', true],
    ['GLACIER_IR', false],
    ['STANDARD', false],
  ])('%s → %s', (storageClass, expected) => {
    expect(s3NeedsThaw({ storageClass })).toBe(expected);
  });
});

// --- s3Ready ---

describe('s3Ready', () => {
  test('INTELLIGENT_TIERING frequent tier → true', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(headResponse());
    expect(await s3Ready(env(), { key: 'A/R/o1', storageClass: 'INTELLIGENT_TIERING' })).toBe(true);
  });

  test('INTELLIGENT_TIERING archive, restore in progress → false (one HEAD)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      headResponse({
        'x-amz-archive-status': 'ARCHIVE_ACCESS',
        'x-amz-restore': 'ongoing-request="true"',
      }),
    );
    expect(await s3Ready(env(), { key: 'A/R/o1', storageClass: 'INTELLIGENT_TIERING' })).toBe(
      false,
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('INTELLIGENT_TIERING archive, restore complete → true', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      headResponse({
        'x-amz-archive-status': 'ARCHIVE_ACCESS',
        'x-amz-restore': 'ongoing-request="false"',
      }),
    );
    expect(await s3Ready(env(), { key: 'A/R/o1', storageClass: 'INTELLIGENT_TIERING' })).toBe(true);
  });

  test('GLACIER without restore header → false', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(headResponse());
    expect(await s3Ready(env(), { key: 'A/R/o1', storageClass: 'GLACIER' })).toBe(false);
  });

  test('GLACIER restore complete → true', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      headResponse({
        'x-amz-restore': 'ongoing-request="false", expiry-date="Wed, 01 Jan 2025 00:00:00 GMT"',
      }),
    );
    expect(await s3Ready(env(), { key: 'A/R/o1', storageClass: 'GLACIER' })).toBe(true);
  });

  test('GLACIER restore in progress → false', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      headResponse({ 'x-amz-restore': 'ongoing-request="true"' }),
    );
    expect(await s3Ready(env(), { key: 'A/R/o1', storageClass: 'GLACIER' })).toBe(false);
  });

  test('HEAD failure → throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }));
    await expect(s3Ready(env(), { key: 'A/R/o1', storageClass: 'GLACIER' })).rejects.toThrow(
      /S3 HEAD/,
    );
  });
});

// --- s3RestoreObject ---

describe('s3RestoreObject', () => {
  test('POST ?restore with Days for Glacier classes', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 202 }));
    await s3RestoreObject(env(), { key: 'A/R/o1', storageClass: 'GLACIER' });
    const req = spy.mock.calls[0][0] as Request;
    expect(req.method).toBe('POST');
    expect(new URL(req.url).searchParams.has('restore')).toBe(true);
    const body = await req.text();
    expect(body).toContain('<Days>7</Days>');
    expect(body).toContain('<RestoreRequest>');
  });

  test('POST ?restore without Days for INTELLIGENT_TIERING archive', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 202 }));
    await s3RestoreObject(env(), { key: 'A/R/o1', storageClass: 'INTELLIGENT_TIERING' });
    const body = await (spy.mock.calls[0][0] as Request).text();
    expect(body).not.toContain('<Days>');
    expect(body).toContain('<GlacierJobParameters>');
  });

  test('409 RestoreAlreadyInProgress → no-op (idempotent resume)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 409 }));
    await expect(
      s3RestoreObject(env(), { key: 'A/R/o1', storageClass: 'GLACIER' }),
    ).resolves.toBeUndefined();
  });

  test('403 ObjectAlreadyInActiveTierError → no-op (already readable)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<Error><Code>ObjectAlreadyInActiveTierError</Code></Error>', { status: 403 }),
    );
    await expect(
      s3RestoreObject(env(), { key: 'A/R/o1', storageClass: 'STANDARD' }),
    ).resolves.toBeUndefined();
  });

  test('403 InvalidObjectState → no-op (IT object not in an archive tier)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<Error><Code>InvalidObjectState</Code></Error>', { status: 403 }),
    );
    await expect(
      s3RestoreObject(env(), { key: 'A/R/o1', storageClass: 'INTELLIGENT_TIERING' }),
    ).resolves.toBeUndefined();
  });

  test('403 AccessDenied → throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }),
    );
    await expect(
      s3RestoreObject(env(), { key: 'A/R/o1', storageClass: 'GLACIER' }),
    ).rejects.toThrow(/RestoreObject/);
  });

  test('other failure → throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
    await expect(
      s3RestoreObject(env(), { key: 'A/R/o1', storageClass: 'GLACIER' }),
    ).rejects.toThrow(/RestoreObject/);
  });
});

// --- copyS3toR2 ---

// Route S3 by method+query; R2 is a binding stub we assert on.
function copyEnv(coldSize: number) {
  const put = vi.fn(async () => {});
  const uploadPart = vi.fn(async (partNumber: number) => ({ partNumber, etag: `e${partNumber}` }));
  const complete = vi.fn(async () => {});
  const abort = vi.fn(async () => {});
  const createMultipartUpload = vi.fn(async () => ({ uploadPart, complete, abort }));
  const e = {
    ...env(),
    LFS_BUCKET: { head: vi.fn(async () => null), put, createMultipartUpload },
  } as unknown as CloudflareBindings;
  const calls: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const req = input as Request;
    calls.push(req);
    if (req.method === 'HEAD')
      return new Response(null, { status: 200, headers: { 'content-length': String(coldSize) } });
    return new Response('bytes', { status: 200 }); // GET (whole or ranged)
  });
  return { e, calls, r2: { put, createMultipartUpload, uploadPart, complete, abort } };
}
const r2head = (e: CloudflareBindings) => e.LFS_BUCKET.head as unknown as ReturnType<typeof vi.fn>;

describe('copyS3toR2', () => {
  test('live present at the same size → skip (no GET, no put)', async () => {
    const { e, calls, r2 } = copyEnv(100);
    r2head(e).mockResolvedValue({ size: 100 });
    await copyS3toR2(e, 'A/R/o1');
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(0);
    expect(r2.put).not.toHaveBeenCalled();
  });

  test('absent live, ≤ 5 GiB → one whole GET → R2 put', async () => {
    const { e, calls, r2 } = copyEnv(5 * GiB); // exactly the cap → single put
    await copyS3toR2(e, 'A/R/o1');
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
    expect(r2.put).toHaveBeenCalledWith('A/R/o1', expect.anything());
    expect(r2.createMultipartUpload).not.toHaveBeenCalled();
  });

  test('> 5 GiB → R2 multipart from ranged GETs, then complete', async () => {
    const { e, calls, r2 } = copyEnv(5 * GiB + 1); // 6 parts at 1 GiB
    await copyS3toR2(e, 'A/R/big');
    expect(r2.createMultipartUpload).toHaveBeenCalledWith('A/R/big');
    expect(r2.uploadPart).toHaveBeenCalledTimes(6);
    const ranges = calls.filter((c) => c.method === 'GET').map((c) => c.headers.get('range'));
    expect(ranges).toContain(`bytes=0-${GiB - 1}`);
    expect(ranges).toContain(`bytes=${5 * GiB}-${5 * GiB}`); // 1-byte tail
    expect(r2.complete).toHaveBeenCalledWith(
      expect.arrayContaining([{ partNumber: 1, etag: 'e1' }]),
    );
  });

  test('a part GET failure → aborts the multipart upload + throws', async () => {
    const { e, r2 } = copyEnv(5 * GiB + 1);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const req = input as Request;
      if (req.method === 'HEAD')
        return new Response(null, {
          status: 200,
          headers: { 'content-length': String(5 * GiB + 1) },
        });
      return new Response(null, { status: 503 }); // ranged GET fails
    });
    await expect(copyS3toR2(e, 'A/R/big')).rejects.toThrow(/ranged GET/);
    expect(r2.abort).toHaveBeenCalled();
  });

  test('S3 HEAD failure → throws', async () => {
    const { e } = copyEnv(100);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
    await expect(copyS3toR2(e, 'A/R/o1')).rejects.toThrow(/S3 HEAD/);
  });
});
