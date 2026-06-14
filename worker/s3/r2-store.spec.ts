import { describe, expect, test, vi } from 'vitest';

import { r2Store } from '@/s3/r2-store';

const body = () => new ReadableStream();

// Minimal R2 bucket double — only the methods `r2Store` reaches.
function bucketEnv(over: Record<string, unknown> = {}) {
  const upload = {
    uploadPart: vi.fn(async (partNumber: number) => ({ partNumber, etag: `e${partNumber}` })),
    complete: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  const bucket = {
    head: vi.fn(async () => null),
    get: vi.fn(async () => null),
    put: vi.fn(async () => {}),
    createMultipartUpload: vi.fn(async () => upload),
    ...over,
  };
  return { env: { LFS_BUCKET: bucket } as unknown as CloudflareBindings, bucket, upload };
}

describe('r2Store.size', () => {
  test('returns the head size', async () => {
    const { env } = bucketEnv({ head: vi.fn(async () => ({ size: 42 })) });
    expect(await r2Store(env).size('k')).toBe(42);
  });

  test('null when the object is gone', async () => {
    const { env } = bucketEnv();
    expect(await r2Store(env).size('k')).toBeNull();
  });
});

describe('r2Store.read', () => {
  test('returns the object body', async () => {
    const stream = body();
    const { env } = bucketEnv({ get: vi.fn(async () => ({ body: stream })) });
    expect(await r2Store(env).read('k')).toBe(stream);
  });

  test('null when the object was deleted since listing', async () => {
    const { env } = bucketEnv();
    expect(await r2Store(env).read('k')).toBeNull();
  });
});

describe('r2Store.readRange', () => {
  test('passes the range and returns the body', async () => {
    const stream = body();
    const { env, bucket } = bucketEnv({ get: vi.fn(async () => ({ body: stream })) });
    expect(await r2Store(env).readRange('k', 10, 5)).toBe(stream);
    expect(bucket.get).toHaveBeenCalledWith('k', { range: { offset: 10, length: 5 } });
  });

  test('throws when the ranged object is missing', async () => {
    const { env } = bucketEnv();
    await expect(r2Store(env).readRange('k', 10, 5)).rejects.toThrow('R2 range read k @10 failed');
  });
});

describe('r2Store.write', () => {
  test('puts the body under the key', async () => {
    const { env, bucket } = bucketEnv();
    const stream = body();
    await r2Store(env).write('k', stream);
    expect(bucket.put).toHaveBeenCalledWith('k', stream);
  });
});

describe('r2Store.startMultipart', () => {
  test('delegates part/complete/abort to the R2 upload', async () => {
    const { env, upload } = bucketEnv();
    const writer = await r2Store(env).startMultipart('k');
    const stream = body();
    await writer.part(1, 100, stream);
    await writer.complete([{ partNumber: 1, etag: 'e1' }]);
    await writer.abort();
    expect(upload.uploadPart).toHaveBeenCalledWith(1, stream);
    expect(upload.complete).toHaveBeenCalledWith([{ partNumber: 1, etag: 'e1' }]);
    expect(upload.abort).toHaveBeenCalled();
  });
});
