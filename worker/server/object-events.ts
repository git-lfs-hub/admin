import type { ObjectEvent } from '@git-lfs-hub/lib/contracts';

import { Registry } from '@/db/registry';
import { Storage } from '@/db/storage';

export type { ObjectEvent };

export async function handleObjectEvents(
  batch: MessageBatch<ObjectEvent>,
  env: CloudflareBindings,
): Promise<void> {
  if (batch.messages.length === 0) return;
  const registry = Registry.global(env);
  const seen = new Set<string>();
  const uploaded = new Set<string>();
  for (const msg of batch.messages) {
    const { owner, repo: repoName, oid, size, operation } = msg.body;
    const prefix = `${owner}/${repoName}`;
    if (!seen.has(prefix)) {
      seen.add(prefix);
      await registry.upsertStorage(prefix);
    }
    // An upload may diverge live from any cold copy — bump lastChangeAt + reset backupComplete.
    if (operation === 'upload' && !uploaded.has(prefix)) {
      uploaded.add(prefix);
      await registry.recordUpload(prefix);
    }
    const store = Storage.byPrefix(env, prefix);
    await store.recordObject(oid, size, operation);
  }
}
