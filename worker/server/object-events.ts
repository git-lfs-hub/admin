import type { ObjectEvent } from '@git-lfs-hub/lib/contracts'

export type { ObjectEvent }

export async function handleObjectEvents(
  batch: MessageBatch<ObjectEvent>,
  env: CloudflareBindings,
): Promise<void> {
  if (batch.messages.length === 0) return
  const repos = env.REPOS.get(env.REPOS.idFromName('global'))
  const seen = new Set<string>()
  for (const msg of batch.messages) {
    const { owner, repo, oid, size, operation } = msg.body
    const key = `${owner}/${repo}`
    if (!seen.has(key)) {
      seen.add(key)
      await repos.upsert(owner, repo)
    }
    const index = env.INDEX.get(env.INDEX.idFromName(key))
    await index.recordObject(oid, size, operation)
  }
}
