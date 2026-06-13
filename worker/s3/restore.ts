import { s3BackupClient, s3ObjectUrl } from '@/s3/client';
import type { S3Object } from '@/s3/list';

// Thaw helpers: Glacier Flexible/Deep Archive need RestoreObject + a wait. Known immediate classes
// skip that; INTELLIGENT_TIERING needs a HEAD (`x-amz-archive-status`); unknown classes attempt restore.

export const IMMEDIATE_CLASSES = new Set([
  'GLACIER_IR',
  'STANDARD',
  'REDUCED_REDUNDANCY',
  'STANDARD_IA',
  'ONEZONE_IA',
]);

const IT_ARCHIVE = new Set(['ARCHIVE_ACCESS', 'DEEP_ARCHIVE_ACCESS']);

export function s3NeedsThaw(o: Pick<S3Object, 'storageClass'>): boolean {
  return !IMMEDIATE_CLASSES.has(o.storageClass);
}

// Kick off an async Glacier retrieval (POST `?restore`). Idempotent: `409` (in progress) and the
// already-readable 403s (see `RESTORE_NOOP_CODES`) are no-ops; a 200 means a restored copy exists.
// IT archive tiers omit `Days` (AWS moves the object back to Frequent Access, no temporary copy).
export async function s3RestoreObject(env: CloudflareBindings, o: S3Object): Promise<void> {
  const aws = s3BackupClient(env);
  const days = o.storageClass === 'INTELLIGENT_TIERING' ? '' : '<Days>7</Days>';
  const params = '<GlacierJobParameters><Tier>Standard</Tier></GlacierJobParameters>';
  const body = `<RestoreRequest>${days}${params}</RestoreRequest>`;
  const res = await aws.fetch(`${s3ObjectUrl(env, o.key)}?restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/xml' },
    body,
  });
  if (res.ok || res.status === 409) return; // 409 = in progress
  if (res.status === 403) {
    const body = await res.text();
    if (RESTORE_NOOP_CODES.some((code) => body.includes(`<Code>${code}</Code>`))) return;
  }
  throw new Error(`S3 RestoreObject ${o.key} failed: ${res.status}`);
}

// 403 codes that mean "already readable, nothing to restore": a restored copy is already in the
// active tier (Glacier classes), or the object isn't in an archived state at all — what AWS returns
// for an IT object sitting in the Frequent/Infrequent access tier.
const RESTORE_NOOP_CODES = ['ObjectAlreadyInActiveTierError', 'InvalidObjectState'];

export async function s3Ready(env: CloudflareBindings, o: S3Object): Promise<boolean> {
  const aws = s3BackupClient(env);
  const res = await aws.fetch(s3ObjectUrl(env, o.key), { method: 'HEAD' });
  if (!res.ok) throw new Error(`S3 HEAD ${o.key} failed: ${res.status}`);
  if (o.storageClass === 'INTELLIGENT_TIERING') {
    const archiveStatus = res.headers.get('x-amz-archive-status') ?? undefined;
    if (!archiveStatus || !IT_ARCHIVE.has(archiveStatus)) return true;
  }
  const restore = res.headers.get('x-amz-restore') ?? undefined;
  return restore?.includes('ongoing-request="false"') ?? false;
}
