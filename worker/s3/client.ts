import { AwsClient } from 'aws4fetch';

// Shared SigV4 access to the external `s3.backup` bucket (AWS S3, no wrangler binding). Used by all
// cold-storage ops; callers are gated on `GC.coldStorage`.

// Lets aws4fetch stream a body unhashed (it can't SHA-256 a ReadableStream); S3-over-TLS accepts it.
export const UNSIGNED_STREAM = { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' } as const;

export function s3BackupClient(env: CloudflareBindings): AwsClient {
  return new AwsClient({
    accessKeyId: env.S3_BACKUP_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.S3_BACKUP_SECRET_ACCESS_KEY ?? '',
    service: 's3',
    region: env.S3.backup.region,
    retries: 0,
  });
}

// Path-style URL `https://s3.{region}.amazonaws.com/{bucket}/{key…}` (slashes in `key` stay path segments).
export function s3ObjectUrl(env: CloudflareBindings, key: string): string {
  const { region, bucket } = env.S3.backup;
  const segments = [bucket, ...key.split('/')].map((s) =>
    encodeURIComponent(s).replace(/%2F/g, '/'),
  );
  return `https://s3.${region}.amazonaws.com/${segments.join('/')}`;
}
