import type { ObjectEvent } from '@git-lfs-hub/contracts'

export type { ObjectEvent }

export async function handleObjectEvents(
  batch: MessageBatch<ObjectEvent>,
  env: CloudflareBindings,
): Promise<void> {
  if (batch.messages.length === 0) return
  const repos = env.REPOS.get(env.REPOS.idFromName('global'))
  const seen = new Set<string>()
  for (const msg of batch.messages) {
    const { owner, repo } = msg.body
    const key = `${owner}/${repo}`
    if (seen.has(key)) continue
    seen.add(key)
    await repos.upsert(owner, repo)
  }
}
