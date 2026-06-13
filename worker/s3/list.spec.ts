import { afterEach, describe, expect, test, vi } from 'vitest';

import { listS3Page } from '@/s3/list';

function env() {
  return {
    S3: { backup: { region: 'us-east-1', bucket: 'cold-bucket' } },
    S3_BACKUP_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    S3_BACKUP_SECRET_ACCESS_KEY: 'secret',
  } as unknown as CloudflareBindings;
}

afterEach(() => vi.restoreAllMocks());

const listXml = (contents: string, opts: { truncated?: boolean; next?: string } = {}) =>
  `<ListBucketResult>${contents}` +
  `<IsTruncated>${opts.truncated ? 'true' : 'false'}</IsTruncated>` +
  (opts.next ? `<NextContinuationToken>${opts.next}</NextContinuationToken>` : '') +
  `</ListBucketResult>`;
const obj = (key: string, cls: string) =>
  `<Contents><Key>${key}</Key><StorageClass>${cls}</StorageClass></Contents>`;

describe('listS3Page', () => {
  test('parses keys + storage class; not truncated → no cursor', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(listXml(obj('A/R/o1', 'GLACIER_IR') + obj('A/R/o2', 'DEEP_ARCHIVE'))),
    );
    const page = await listS3Page(env(), 'A/R/');
    expect(page.objects).toEqual([
      { key: 'A/R/o1', storageClass: 'GLACIER_IR' },
      { key: 'A/R/o2', storageClass: 'DEEP_ARCHIVE' },
    ]);
    expect(page.cursor).toBeUndefined();
  });

  test('passes prefix + continuation-token, returns next cursor when truncated', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(listXml(obj('A/R/o1', 'GLACIER'), { truncated: true, next: 'c2' })),
      );
    const page = await listS3Page(env(), 'A/R/', 'c1');
    expect(page.cursor).toBe('c2');
    const url = new URL((spy.mock.calls[0][0] as Request).url);
    expect(url.searchParams.get('list-type')).toBe('2');
    expect(url.searchParams.get('prefix')).toBe('A/R/');
    expect(url.searchParams.get('continuation-token')).toBe('c1');
  });

  test('empty listing → no objects', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(listXml('')));
    expect((await listS3Page(env(), 'A/R/')).objects).toEqual([]);
  });

  test('non-2xx → throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    await expect(listS3Page(env(), 'A/R/')).rejects.toThrow(/ListObjectsV2/);
  });
});
