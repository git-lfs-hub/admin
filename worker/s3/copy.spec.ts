import { describe, expect, test, vi } from 'vitest';

import { type BlobStore, copyObject, type MultipartWriter } from '@/s3/copy';

const GiB = 1024 ** 3;
const body = () => new ReadableStream();

// In-memory BlobStore double: `size` is fixed; reads return a stream; writes/parts are recorded.
function store(size: number | null, opts: { read?: ReadableStream | null } = {}) {
  const writer: MultipartWriter = {
    part: vi.fn(async (partNumber: number) => ({ partNumber, etag: `e${partNumber}` })),
    complete: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  return {
    writer,
    store: {
      size: vi.fn(async () => size),
      read: vi.fn(async () => ('read' in opts ? opts.read! : body())),
      readRange: vi.fn(async () => body()),
      write: vi.fn(async () => {}),
      startMultipart: vi.fn(async () => writer),
    } satisfies BlobStore,
  };
}

describe('copyObject', () => {
  test('source missing (size null) → no-op, never touches dst', async () => {
    const src = store(null);
    const dst = store(0);
    await copyObject('k', src.store, dst.store);
    expect(dst.store.size).not.toHaveBeenCalled();
    expect(dst.store.write).not.toHaveBeenCalled();
  });

  test('dst already holds the same size → skip (no read, no write)', async () => {
    const src = store(100);
    const dst = store(100);
    await copyObject('k', src.store, dst.store);
    expect(src.store.read).not.toHaveBeenCalled();
    expect(dst.store.write).not.toHaveBeenCalled();
  });

  test('≤ 5 GiB (the cap), dst absent → whole read → write', async () => {
    const src = store(5 * GiB, { read: body() }); // exactly the single-put cap → whole, not multipart
    const dst = store(null);
    await copyObject('k', src.store, dst.store);
    expect(src.store.read).toHaveBeenCalledWith('k');
    expect(dst.store.write).toHaveBeenCalledWith('k', expect.anything(), 5 * GiB);
    expect(dst.store.startMultipart).not.toHaveBeenCalled();
  });

  test('raced deletion (read returns null) → no write', async () => {
    const src = store(100, { read: null });
    const dst = store(null);
    await copyObject('k', src.store, dst.store);
    expect(src.store.read).toHaveBeenCalled();
    expect(dst.store.write).not.toHaveBeenCalled();
  });

  test('> 5 GiB → multipart: one part per 1 GiB range, then complete', async () => {
    const src = store(5 * GiB + 1); // 6 parts (last = 1 byte)
    const dst = store(null);
    await copyObject('k', src.store, dst.store);
    expect(dst.store.write).not.toHaveBeenCalled();
    expect(dst.writer.part).toHaveBeenCalledTimes(6);
    expect(src.store.readRange).toHaveBeenCalledWith('k', 0, GiB);
    expect(src.store.readRange).toHaveBeenCalledWith('k', 5 * GiB, 1);
    expect(dst.writer.complete).toHaveBeenCalledWith(
      expect.arrayContaining([{ partNumber: 1, etag: 'e1' }]),
    );
    expect(dst.writer.abort).not.toHaveBeenCalled();
  });

  test('multipart part failure → aborts + throws', async () => {
    const src = store(5 * GiB + 1);
    const dst = store(null);
    (dst.writer.part as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('part boom'));
    await expect(copyObject('k', src.store, dst.store)).rejects.toThrow('part boom');
    expect(dst.writer.abort).toHaveBeenCalled();
  });
});
