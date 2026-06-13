import { s3BackupClient, s3ObjectUrl } from '@/s3/client';

// Drop one backup-bucket object. Idempotent — S3 DELETE is a 204 no-op when the key is gone, so a
// resumed page re-deletes harmlessly.
export async function s3DeleteObject(env: CloudflareBindings, key: string): Promise<void> {
  const aws = s3BackupClient(env);
  const res = await aws.fetch(s3ObjectUrl(env, key), { method: 'DELETE' });
  if (res.ok || res.status === 404) return;
  throw new Error(`S3 DeleteObject ${key} failed: ${res.status}`);
}
