import type { AwsClient } from 'aws4fetch';

import { s3BackupClient, s3ObjectUrl, UNSIGNED_STREAM } from '@/s3/client';

// S3 single-PUT caps at 5 GiB; larger objects go through multipart, streamed from ranged R2 reads
// so nothing buffers in the Worker's 128 MB. 1 GiB parts (≤10k parts) → objects up to ~10 TiB.
const SINGLE_PUT_MAX = 5 * 1024 ** 3;
const PART_SIZE = 1 * 1024 ** 3;
const PART_CONCURRENCY = 4;

type Part = { partNumber: number; etag: string };

/**
 * Copy one live R2 object into the backup bucket in the given Glacier class. Idempotent: a present
 * cold object of the same size is a complete copy (content-addressed oid + atomic S3 writes ⇒ never
 * partial), so a re-BackUp / resumed page HEAD-skips it.
 */
export async function copyR2toS3(
  env: CloudflareBindings,
  key: string,
  storageClass: 'GLACIER_IR',
): Promise<void> {
  const aws = s3BackupClient(env);
  const url = s3ObjectUrl(env, key);

  const live = await env.LFS_BUCKET.head(key);
  if (!live) return; // deleted since listing

  const head = await aws.fetch(url, { method: 'HEAD' });
  if (head.ok) {
    if (Number(head.headers.get('content-length')) === live.size) return;
    // present but wrong size → overwrite
  } else if (head.status !== 404) {
    throw new Error(`S3 HEAD ${key} failed: ${head.status}`);
  }

  if (live.size <= SINGLE_PUT_MAX) {
    await putWhole(aws, env, url, key, live.size, storageClass);
  } else {
    await putMultipart(aws, env, url, key, live.size, storageClass);
  }
}

// --- single PUT (≤ 5 GiB) ---

async function putWhole(
  aws: AwsClient,
  env: CloudflareBindings,
  url: string,
  key: string,
  size: number,
  storageClass: string,
): Promise<void> {
  const obj = await env.LFS_BUCKET.get(key);
  if (!obj) return; // raced deletion
  const put = await aws.fetch(url, {
    method: 'PUT',
    body: obj.body,
    headers: {
      'content-length': String(size),
      'x-amz-storage-class': storageClass,
      ...UNSIGNED_STREAM,
    },
  });
  if (!put.ok) throw new Error(`S3 PUT ${key} failed: ${put.status}`);
}

// --- multipart (> 5 GiB) ---

async function putMultipart(
  aws: AwsClient,
  env: CloudflareBindings,
  url: string,
  key: string,
  size: number,
  storageClass: string,
): Promise<void> {
  const uploadId = await createMultipart(aws, url, key, storageClass);
  // Abort on failure so parts don't linger; a bucket lifecycle rule reaps uploads orphaned by a
  // Worker death mid-flight (out-of-band).
  try {
    const partCount = Math.ceil(size / PART_SIZE);
    const parts: Part[] = [];
    for (let i = 0; i < partCount; i += PART_CONCURRENCY) {
      const batch = Array.from({ length: Math.min(PART_CONCURRENCY, partCount - i) }, (_, j) =>
        uploadPart(aws, env, url, key, uploadId, i + j, size),
      );
      parts.push(...(await Promise.all(batch)));
    }
    parts.sort((a, b) => a.partNumber - b.partNumber);
    await completeMultipart(aws, url, key, uploadId, parts);
  } catch (e) {
    await abortMultipart(aws, url, uploadId).catch(() => {});
    throw e;
  }
}

async function uploadPart(
  aws: AwsClient,
  env: CloudflareBindings,
  url: string,
  key: string,
  uploadId: string,
  index: number,
  size: number,
): Promise<Part> {
  const offset = index * PART_SIZE;
  const length = Math.min(PART_SIZE, size - offset);
  const partNumber = index + 1; // S3 part numbers are 1-based
  const obj = await env.LFS_BUCKET.get(key, { range: { offset, length } });
  if (!obj) throw new Error(`R2 range read ${key} @${offset} failed`);
  const res = await aws.fetch(partUrl(url, partNumber, uploadId), {
    method: 'PUT',
    body: obj.body,
    headers: { 'content-length': String(length), ...UNSIGNED_STREAM },
  });
  if (!res.ok) throw new Error(`S3 UploadPart ${key} #${partNumber} failed: ${res.status}`);
  const etag = res.headers.get('etag');
  if (!etag) throw new Error(`S3 UploadPart ${key} #${partNumber} missing ETag`);
  return { partNumber, etag };
}

async function createMultipart(
  aws: AwsClient,
  url: string,
  key: string,
  storageClass: string,
): Promise<string> {
  const res = await aws.fetch(`${url}?uploads`, {
    method: 'POST',
    headers: { 'x-amz-storage-class': storageClass },
  });
  if (!res.ok) throw new Error(`S3 CreateMultipartUpload ${key} failed: ${res.status}`);
  const uploadId = (await res.text()).match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  if (!uploadId) throw new Error(`S3 CreateMultipartUpload ${key}: no UploadId`);
  return uploadId;
}

async function completeMultipart(
  aws: AwsClient,
  url: string,
  key: string,
  uploadId: string,
  parts: Part[],
): Promise<void> {
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
}

function abortMultipart(aws: AwsClient, url: string, uploadId: string): Promise<Response> {
  return aws.fetch(`${url}?uploadId=${encodeURIComponent(uploadId)}`, { method: 'DELETE' });
}

// --- helpers ---

function partUrl(url: string, partNumber: number, uploadId: string): string {
  return `${url}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`;
}
