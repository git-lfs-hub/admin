import { s3BackupClient, s3BucketUrl } from '@/s3/client';

// List one cursor-paginated page of backup-bucket objects under a prefix (ListObjectsV2). Returns
// each object's key + storage class so the caller knows whether a thaw is needed. Drives the
// cold-storage workflow walk (`walkS3Pages`); the backup/purge side walks live R2 instead.

export type S3Object = { key: string; storageClass: string };
export type S3ListPage = { prefix: string; objects: S3Object[]; cursor?: string };

// The page is bounded (≤1000 keys), so returning the list from a workflow step stays under the step
// state-size cap.
export async function listS3Page(
  env: CloudflareBindings,
  prefix: string,
  cursor?: string,
): Promise<S3ListPage> {
  const aws = s3BackupClient(env);
  const params = new URLSearchParams({ 'list-type': '2', prefix });
  if (cursor) params.set('continuation-token', cursor);
  const res = await aws.fetch(`${s3BucketUrl(env)}?${params}`);
  if (!res.ok) throw new Error(`S3 ListObjectsV2 ${prefix} failed: ${res.status}`);
  const xml = await res.text();
  const objects = [...xml.matchAll(/<Contents>(.*?)<\/Contents>/gs)].map((m) => ({
    key: tag(m[1], 'Key'),
    storageClass: tag(m[1], 'StorageClass') || 'STANDARD',
  }));
  const truncated = tag(xml, 'IsTruncated') === 'true';
  return { prefix, objects, cursor: truncated ? tag(xml, 'NextContinuationToken') : undefined };
}

// First `<name>…</name>` text (S3 list XML), or '' when absent.
function tag(xml: string, name: string): string {
  return xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1] ?? '';
}
