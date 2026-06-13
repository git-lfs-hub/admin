import { s3BackupClient, s3ObjectUrl } from '@/s3/client';

// Cold-storage deletion: drop one backup-bucket object. Idempotent — S3 returns 204 for a present
// key and 204 for an absent one (DELETE is a no-op when the key is gone), so a resumed page
// re-deletes harmlessly. Drives the Delete Backup walk (F4); the cold-Purge S3 pass (F6) reuses it.
export async function s3DeleteObject(env: CloudflareBindings, key: string): Promise<void> {
  const aws = s3BackupClient(env);
  const res = await aws.fetch(s3ObjectUrl(env, key), { method: 'DELETE' });
  if (res.ok || res.status === 404) return;
  throw new Error(`S3 DeleteObject ${key} failed: ${res.status}`);
}
