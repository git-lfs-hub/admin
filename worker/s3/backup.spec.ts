import { afterEach, describe, expect, test, vi } from 'vitest';

import { copyObject } from '@/s3/copy';
import { r2Store } from '@/s3/r2-store';
import { s3Store } from '@/s3/s3-store';

// The backup direction (R2 → S3) of `copyObject`, exercised through the real stores so this covers
// the S3 store's write/multipart paths + the R2 store's reads (the inlined `copyR2toS3` workflow call).
const copyR2toS3 = (env: CloudflareBindings, key: string, storageClass: 'GLACIER_IR') =>
  copyObject(key, r2Store(env), s3Store(env, storageClass));

const GiB = 1024 ** 3;

function envWith(size: number | null) {
  const get = vi.fn(async (_key: string, opts?: { range?: { offset: number; length: number } }) =>
    size == null ? null : { body: 'bytes', size, range: opts?.range },
  );
  const head = vi.fn(async () => (size == null ? null : { size }));
  return {
    S3: { backup: { region: 'us-east-1', bucket: 'cold-bucket' } },
    S3_BACKUP_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    S3_BACKUP_SECRET_ACCESS_KEY: 'secret',
    LFS_BUCKET: { head, get },
  } as unknown as CloudflareBindings;
}
const r2 = (env: CloudflareBindings) =>
  env.LFS_BUCKET as unknown as { head: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };

// aws4fetch signs (header-based) then calls global `fetch` with a single Request whose URL keeps
// only our own query (?uploads / ?partNumber&uploadId). Route the S3 API by method + query.
function s3Mock(
  opts: {
    headStatus?: number;
    headSize?: number;
    completeBody?: string;
    partStatus?: number;
    putStatus?: number;
  } = {},
) {
  const calls: Request[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const req = input as Request;
    calls.push(req);
    const q = new URL(req.url).searchParams;
    if (req.method === 'HEAD')
      return new Response(null, {
        status: opts.headStatus ?? 404,
        headers: opts.headSize != null ? { 'content-length': String(opts.headSize) } : {},
      });
    if (req.method === 'POST' && q.has('uploads'))
      return new Response('<UploadId>UP1</UploadId>', { status: 200 });
    if (req.method === 'PUT' && q.has('partNumber'))
      return new Response(null, {
        status: opts.partStatus ?? 200,
        headers: { etag: `"e${q.get('partNumber')}"` },
      });
    if (req.method === 'POST' && q.has('uploadId'))
      return new Response(opts.completeBody ?? '<CompleteMultipartUploadResult/>', { status: 200 });
    if (req.method === 'DELETE') return new Response(null, { status: 204 }); // abort
    if (req.method === 'PUT') return new Response(null, { status: opts.putStatus ?? 200 }); // single whole PUT
    return new Response(null, { status: 500 });
  });
  return { spy, calls };
}
const byMethod = (calls: Request[], method: string, has?: string) =>
  calls.filter((r) => r.method === method && (has == null || new URL(r.url).searchParams.has(has)));

afterEach(() => vi.restoreAllMocks());

describe('copyR2toS3 — skip / no-op', () => {
  test('cold object present at the same size → skip (no R2 read, no PUT)', async () => {
    const env = envWith(100);
    const { calls } = s3Mock({ headStatus: 200, headSize: 100 });
    await copyR2toS3(env, 'A/R/oid', 'GLACIER_IR');
    expect(byMethod(calls, 'PUT')).toHaveLength(0);
    expect(r2(env).get).not.toHaveBeenCalled();
  });

  test('cold object present but wrong size → overwrites', async () => {
    const env = envWith(100);
    const { calls } = s3Mock({ headStatus: 200, headSize: 50 });
    await copyR2toS3(env, 'A/R/oid', 'GLACIER_IR');
    expect(byMethod(calls, 'PUT')).toHaveLength(1);
  });

  test('object gone from live (head null) → no S3 call at all', async () => {
    const env = envWith(null);
    const { spy } = s3Mock();
    await copyR2toS3(env, 'A/R/gone', 'GLACIER_IR');
    expect(spy).not.toHaveBeenCalled();
  });

  test('S3 HEAD non-404 error → throws', async () => {
    const env = envWith(100);
    s3Mock({ headStatus: 500 });
    await expect(copyR2toS3(env, 'A/R/oid', 'GLACIER_IR')).rejects.toThrow(/S3 HEAD/);
  });
});

describe('copyR2toS3 — single PUT (≤ 5 GiB)', () => {
  test('cold absent → one whole PUT, path-style, GLACIER_IR, unsigned stream', async () => {
    const env = envWith(5 * GiB); // exactly the cap → single PUT
    const { calls } = s3Mock({ headStatus: 404 });
    await copyR2toS3(env, 'A/R/oid', 'GLACIER_IR');
    const put = byMethod(calls, 'PUT');
    expect(put).toHaveLength(1);
    expect(put[0].url).toBe('https://s3.us-east-1.amazonaws.com/cold-bucket/A/R/oid');
    expect(put[0].headers.get('x-amz-storage-class')).toBe('GLACIER_IR');
    expect(put[0].headers.get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD');
    expect(r2(env).get).toHaveBeenCalledWith('A/R/oid'); // whole object, no range
  });

  test('single PUT failure → throws', async () => {
    const env = envWith(1024);
    s3Mock({ headStatus: 404, putStatus: 503 });
    await expect(copyR2toS3(env, 'A/R/oid', 'GLACIER_IR')).rejects.toThrow(/S3 PUT/);
  });
});

describe('copyR2toS3 — multipart (> 5 GiB)', () => {
  const size = 5 * GiB + 1; // 6 parts at 1 GiB each (last part = 1 byte)

  test('streams ranged parts → create, N UploadPart, complete', async () => {
    const env = envWith(size);
    const { calls } = s3Mock({ headStatus: 404 });
    await copyR2toS3(env, 'A/R/big', 'GLACIER_IR');

    const create = byMethod(calls, 'POST', 'uploads');
    expect(create).toHaveLength(1);
    expect(create[0].headers.get('x-amz-storage-class')).toBe('GLACIER_IR');

    const parts = byMethod(calls, 'PUT', 'partNumber');
    expect(parts).toHaveLength(6);
    // Parts read from R2 as exact ranges (no buffering) — first full GiB, last the 1-byte tail.
    const ranges = r2(env).get.mock.calls.map((c) => c[1]?.range);
    expect(ranges).toContainEqual({ offset: 0, length: GiB });
    expect(ranges).toContainEqual({ offset: 5 * GiB, length: 1 });

    const complete = byMethod(calls, 'POST', 'uploadId');
    expect(complete).toHaveLength(1);
    const body = await complete[0].text();
    expect((body.match(/<Part>/g) ?? []).length).toBe(6);
    expect(body).toContain('<PartNumber>1</PartNumber>');
    expect(body).toContain('<ETag>"e1"</ETag>');
  });

  test('Complete returns 200 with an <Error> body → throws + aborts', async () => {
    const env = envWith(size);
    const { calls } = s3Mock({
      headStatus: 404,
      completeBody: '<Error><Code>InternalError</Code></Error>',
    });
    await expect(copyR2toS3(env, 'A/R/big', 'GLACIER_IR')).rejects.toThrow(
      /CompleteMultipartUpload/,
    );
    expect(byMethod(calls, 'DELETE')).toHaveLength(1); // abort cleanup
  });

  test('a part upload failure → throws + aborts', async () => {
    const env = envWith(size);
    const { calls } = s3Mock({ headStatus: 404, partStatus: 503 });
    await expect(copyR2toS3(env, 'A/R/big', 'GLACIER_IR')).rejects.toThrow(/UploadPart/);
    expect(byMethod(calls, 'DELETE')).toHaveLength(1);
  });
});
