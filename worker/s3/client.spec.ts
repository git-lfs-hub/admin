import { describe, expect, test } from 'vitest';

import { s3BackupClient, s3ObjectUrl, s3BucketUrl } from '@/s3/client';

function s3Env(over: Record<string, unknown> = {}) {
  return {
    S3: { backup: { region: 'us-east-1', bucket: 'lfs-backup' } },
    S3_BACKUP_ACCESS_KEY_ID: 'AKIA',
    S3_BACKUP_SECRET_ACCESS_KEY: 'secret',
    ...over,
  } as unknown as CloudflareBindings;
}

describe('s3BackupClient', () => {
  test('builds a SigV4 client from the configured creds', () => {
    const client = s3BackupClient(s3Env());
    expect(client.accessKeyId).toBe('AKIA');
    expect(client.secretAccessKey).toBe('secret');
  });

  test('falls back to empty creds when the env keys are unset', () => {
    const client = s3BackupClient(
      s3Env({ S3_BACKUP_ACCESS_KEY_ID: undefined, S3_BACKUP_SECRET_ACCESS_KEY: undefined }),
    );
    expect(client.accessKeyId).toBe('');
    expect(client.secretAccessKey).toBe('');
  });
});

describe('s3ObjectUrl', () => {
  test('path-style URL, keeping slashes as path segments', () => {
    expect(s3ObjectUrl(s3Env(), 'owner/repo/ab/cd.bin')).toBe(
      'https://s3.us-east-1.amazonaws.com/lfs-backup/owner/repo/ab/cd.bin',
    );
  });

  test('percent-encodes reserved characters within a segment', () => {
    expect(s3ObjectUrl(s3Env(), 'a b/c+d')).toBe(
      'https://s3.us-east-1.amazonaws.com/lfs-backup/a%20b/c%2Bd',
    );
  });
});

describe('s3BucketUrl', () => {
  test('bucket-root URL with no trailing slash', () => {
    expect(s3BucketUrl(s3Env())).toBe('https://s3.us-east-1.amazonaws.com/lfs-backup');
  });
});
