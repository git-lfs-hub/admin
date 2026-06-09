import { describe, test, expect, vi } from 'vitest';

import { purgePrefix } from '@/server/lfs-server';

describe('purgePrefix', () => {
  test('splits the prefix into owner/repo and calls purgeRepo', async () => {
    const purgeRepo = vi.fn(async () => {});
    await purgePrefix({ LFS_SERVER: { purgeRepo } } as any, 'a/r');
    expect(purgeRepo).toHaveBeenCalledWith('a', 'r');
  });

  // RPC-after-write: a failed purgeRepo must propagate so the caller leaves its row unchanged.
  test('propagates the RPC failure', async () => {
    const purgeRepo = vi.fn(async () => {
      throw new Error('rpc down');
    });
    await expect(purgePrefix({ LFS_SERVER: { purgeRepo } } as any, 'a/r')).rejects.toThrow(
      'rpc down',
    );
  });
});
