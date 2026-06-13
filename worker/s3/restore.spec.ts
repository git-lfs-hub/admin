import { afterEach, describe, expect, test, vi } from 'vitest';

import { copyS3toR2, s3HeadRestored, s3RestoreObject } from '@/s3/restore';

const GiB = 1024 ** 3;

function env() {
  return {
    S3: { backup: { region: 'us-east-1', bucket: 'cold-bucket' } },
    S3_BACKUP_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    S3_BACKUP_SECRET_ACCESS_KEY: 'secret',
  } as unknown as CloudflareBindings;
}

afterEach(() => vi.restoreAllMocks());

// --- s3RestoreObject ---

describe('s3RestoreObject', () => {
  test('POST ?restore with a RestoreRequest body', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 202 }));
    await s3RestoreObject(env(), 'A/R/o1');
    const req = spy.mock.calls[0][0] as Request;
    expect(req.method).toBe('POST');
    expect(new URL(req.url).searchParams.has('restore')).toBe(true);
    expect(await req.text()).toContain('<RestoreRequest>');
  });

  test('409 RestoreAlreadyInProgress → no-op (idempotent resume)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 409 }));
    await expect(s3RestoreObject(env(), 'A/R/o1')).resolves.toBeUndefined();
  });

  test('other failure → throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
    await expect(s3RestoreObject(env(), 'A/R/o1')).rejects.toThrow(/RestoreObject/);
  });
});

// --- s3HeadRestored ---

describe('s3HeadRestored', () => {
  const head = (restore?: string) =>
    vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(null, { status: 200, headers: restore ? { 'x-amz-restore': restore } : {} }),
      );

  test('ongoing-request="false" → ready', async () => {
    head('ongoing-request="false", expiry-date="Wed, 01 Jan 2025 00:00:00 GMT"');
    expect(await s3HeadRestored(env(), 'A/R/o1')).toBe(true);
  });

  test('ongoing-request="true" → not ready', async () => {
    head('ongoing-request="true"');
    expect(await s3HeadRestored(env(), 'A/R/o1')).toBe(false);
  });

  test('no x-amz-restore header → not ready', async () => {
    head();
    expect(await s3HeadRestored(env(), 'A/R/o1')).toBe(false);
  });

  test('HEAD failure → throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }));
    await expect(s3HeadRestored(env(), 'A/R/o1')).rejects.toThrow(/S3 HEAD/);
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
