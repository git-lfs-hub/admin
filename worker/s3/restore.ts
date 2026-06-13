import type { AwsClient } from 'aws4fetch';

import { s3BackupClient, s3ObjectUrl } from '@/s3/client';

// Cold-storage retrieval: thaw the objects in a colder Glacier tier (`GLACIER`/`DEEP_ARCHIVE` need an
// async `RestoreObject` + wait; `GLACIER_IR` reads immediately), then stream each back into live R2.
// The `RestoreWorkflow` drives the order + sleeps; `listS3Page` (s3/list) enumerates the pages.

// R2's binding caps a single `put()` at 5 GiB; larger objects (the LFS norm) go through R2 multipart,
// each part streamed from a ranged S3 GET so nothing buffers in the Worker's 128 MB. 1 GiB parts.
const SINGLE_PUT_MAX = 5 * 1024 ** 3;
const PART_SIZE = 1 * 1024 ** 3;
const PART_CONCURRENCY = 4;

// Kick off an async Glacier retrieval (POST `?restore`). Idempotent: `409 RestoreAlreadyInProgress`
// is the desired no-op on a resumed step; a 200 means a restored copy already exists.
export async function s3RestoreObject(env: CloudflareBindings, key: string): Promise<void> {
  const aws = s3BackupClient(env);
  const body =
    '<RestoreRequest><Days>7</Days>' +
    '<GlacierJobParameters><Tier>Standard</Tier></GlacierJobParameters></RestoreRequest>';
  const res = await aws.fetch(`${s3ObjectUrl(env, key)}?restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/xml' },
    body,
  });
  if (res.ok || res.status === 409) return;
  throw new Error(`S3 RestoreObject ${key} failed: ${res.status}`);
}

// True once the temporary restored copy is ready — `x-amz-restore: ongoing-request="false"`. A
// `GLACIER_IR` object is always readable, so the workflow never polls it.
export async function s3HeadRestored(env: CloudflareBindings, key: string): Promise<boolean> {
  const aws = s3BackupClient(env);
  const res = await aws.fetch(s3ObjectUrl(env, key), { method: 'HEAD' });
  if (!res.ok) throw new Error(`S3 HEAD ${key} failed: ${res.status}`);
  return res.headers.get('x-amz-restore')?.includes('ongoing-request="false"') ?? false;
}

// Stream one (restored) cold object back into live R2. Idempotent: a live object of the same size is
// a complete copy (content-addressed oid + atomic writes), so a resumed page skips it.
export async function copyS3toR2(env: CloudflareBindings, key: string): Promise<void> {
  const aws = s3BackupClient(env);
  const url = s3ObjectUrl(env, key);

  const head = await aws.fetch(url, { method: 'HEAD' });
  if (!head.ok) throw new Error(`S3 HEAD ${key} failed: ${head.status}`);
  const size = Number(head.headers.get('content-length'));

  const live = await env.LFS_BUCKET.head(key);
  if (live && live.size === size) return;

  if (size <= SINGLE_PUT_MAX) {
    await pullWhole(aws, env, url, key);
  } else {
    await pullMultipart(aws, env, url, key, size);
  }
}

// --- single put (≤ 5 GiB) ---

async function pullWhole(
  aws: AwsClient,
  env: CloudflareBindings,
  url: string,
  key: string,
): Promise<void> {
  const res = await aws.fetch(url);
  if (!res.ok || !res.body) throw new Error(`S3 GET ${key} failed: ${res.status}`);
  await env.LFS_BUCKET.put(key, res.body);
}

// --- multipart (> 5 GiB) ---

async function pullMultipart(
  aws: AwsClient,
  env: CloudflareBindings,
  url: string,
  key: string,
  size: number,
): Promise<void> {
  const upload = await env.LFS_BUCKET.createMultipartUpload(key);
  // Abort on failure so partial uploads don't linger; a resumed page re-creates and refills.
  try {
    const partCount = Math.ceil(size / PART_SIZE);
    const parts: R2UploadedPart[] = [];
    for (let i = 0; i < partCount; i += PART_CONCURRENCY) {
      const batch = Array.from({ length: Math.min(PART_CONCURRENCY, partCount - i) }, (_, j) =>
        pullPart(aws, upload, url, key, i + j, size),
      );
      parts.push(...(await Promise.all(batch)));
    }
    parts.sort((a, b) => a.partNumber - b.partNumber);
    await upload.complete(parts);
  } catch (e) {
    await upload.abort().catch(() => {});
    throw e;
  }
}

async function pullPart(
  aws: AwsClient,
  upload: R2MultipartUpload,
  url: string,
  key: string,
  index: number,
  size: number,
): Promise<R2UploadedPart> {
  const offset = index * PART_SIZE;
  const length = Math.min(PART_SIZE, size - offset);
  const partNumber = index + 1; // R2 part numbers are 1-based
  const res = await aws.fetch(url, {
    headers: { range: `bytes=${offset}-${offset + length - 1}` },
  });
  if (!res.ok || !res.body)
    throw new Error(`S3 ranged GET ${key} @${offset} failed: ${res.status}`);
  return upload.uploadPart(partNumber, res.body);
}
