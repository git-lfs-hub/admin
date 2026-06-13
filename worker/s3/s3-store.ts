import type { AwsClient } from 'aws4fetch';

import { s3BackupClient, s3ObjectUrl, UNSIGNED_STREAM } from '@/s3/client';
import type { BlobStore, MultipartWriter, Part } from '@/s3/copy';

// The external cold-storage bucket (AWS S3, no wrangler binding) as a `BlobStore` — backup's
// destination and restore's source. Writes carry `storageClass` (Glacier) + stream unsigned; reads
// throw on a missing object (it was just listed). `storageClass` is only read on the write paths, so
// restore (read-only) constructs it without one.
export function s3Store(env: CloudflareBindings, storageClass?: string): BlobStore {
  const aws = s3BackupClient(env);
  const url = (key: string) => s3ObjectUrl(env, key);
  const classHeader: Record<string, string> = storageClass
    ? { 'x-amz-storage-class': storageClass }
    : {};
  return {
    async size(key) {
      const res = await aws.fetch(url(key), { method: 'HEAD' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`S3 HEAD ${key} failed: ${res.status}`);
      return Number(res.headers.get('content-length'));
    },

    async read(key) {
      const res = await aws.fetch(url(key));
      if (!res.ok || !res.body) throw new Error(`S3 GET ${key} failed: ${res.status}`);
      return res.body;
    },

    async readRange(key, offset, length) {
      const res = await aws.fetch(url(key), {
        headers: { range: `bytes=${offset}-${offset + length - 1}` },
      });
      if (!res.ok || !res.body)
        throw new Error(`S3 ranged GET ${key} @${offset} failed: ${res.status}`);
      return res.body;
    },

    async write(key, body, size) {
      const res = await aws.fetch(url(key), {
        method: 'PUT',
        body,
        headers: { 'content-length': String(size), ...classHeader, ...UNSIGNED_STREAM },
      });
      if (!res.ok) throw new Error(`S3 PUT ${key} failed: ${res.status}`);
    },

    startMultipart: (key) => startMultipart(aws, url(key), key, classHeader),
  };
}

// Open an S3 multipart upload and return a writer over its `uploadId`. Each part streams from a
// ranged source read; `multipartCopy` orders + completes them and aborts on failure.
async function startMultipart(
  aws: AwsClient,
  url: string,
  key: string,
  classHeader: Record<string, string>,
): Promise<MultipartWriter> {
  const res = await aws.fetch(`${url}?uploads`, { method: 'POST', headers: classHeader });
  if (!res.ok) throw new Error(`S3 CreateMultipartUpload ${key} failed: ${res.status}`);
  const uploadId = (await res.text()).match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  if (!uploadId) throw new Error(`S3 CreateMultipartUpload ${key}: no UploadId`);

  return {
    async part(partNumber, length, body) {
      const res = await aws.fetch(partUrl(url, partNumber, uploadId), {
        method: 'PUT',
        body,
        headers: { 'content-length': String(length), ...UNSIGNED_STREAM },
      });
      if (!res.ok) throw new Error(`S3 UploadPart ${key} #${partNumber} failed: ${res.status}`);
      const etag = res.headers.get('etag');
      if (!etag) throw new Error(`S3 UploadPart ${key} #${partNumber} missing ETag`);
      return { partNumber, etag };
    },

    async complete(parts: Part[]) {
      const body =
        '<CompleteMultipartUpload>' +
        parts
          .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
          .join('') +
        '</CompleteMultipartUpload>';
      const res = await aws.fetch(`${url}?uploadId=${encodeURIComponent(uploadId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/xml' },
        body,
      });
      // CompleteMultipartUpload can return 200 with an `<Error>` body — check the body, not just status.
      const text = await res.text();
      if (!res.ok || text.includes('<Error>'))
        throw new Error(
          `S3 CompleteMultipartUpload ${key} failed: ${res.status} ${text.slice(0, 200)}`,
        );
    },

    abort: () => aws.fetch(`${url}?uploadId=${encodeURIComponent(uploadId)}`, { method: 'DELETE' }),
  };
}

function partUrl(url: string, partNumber: number, uploadId: string): string {
  return `${url}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`;
}
