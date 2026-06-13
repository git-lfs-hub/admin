import { s3BackupClient, s3ObjectUrl } from '@/s3/client';

// Thaw helpers: colder Glacier tiers (`GLACIER`/`DEEP_ARCHIVE`) need an async `RestoreObject` + a wait
// before they're readable (`GLACIER_IR` reads immediately).

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

// True once the restored copy is ready — `x-amz-restore: ongoing-request="false"`.
export async function s3HeadRestored(env: CloudflareBindings, key: string): Promise<boolean> {
  const aws = s3BackupClient(env);
  const res = await aws.fetch(s3ObjectUrl(env, key), { method: 'HEAD' });
  if (!res.ok) throw new Error(`S3 HEAD ${key} failed: ${res.status}`);
  return res.headers.get('x-amz-restore')?.includes('ongoing-request="false"') ?? false;
}
