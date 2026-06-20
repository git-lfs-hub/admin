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
  const confirmed = new Set<string>();
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
    // verify/download head-check R2 server-side → bytes confirmed live.
    if (operation !== 'upload') confirmed.add(prefix);
    const store = Storage.byPrefix(env, prefix);
    await store.recordObject(oid, size, operation);
  }
  // Land the byte half of status now (pending → used on confirm), not at the next reconcile.
  // Events never lose bytes, so missing-detection stays in reconcile.
  for (const prefix of confirmed) {
    await registry.markBytesPresent(prefix);
  }
}
