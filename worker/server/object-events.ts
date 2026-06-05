import type { ObjectEvent } from '@git-lfs-hub/lib/contracts'

export type { ObjectEvent }

export async function handleObjectEvents(
  batch: MessageBatch<ObjectEvent>,
  env: CloudflareBindings,
): Promise<void> {
  if (batch.messages.length === 0) return
  const repos = env.REPOS.getByName('global')
  const seen = new Set<string>()
  for (const msg of batch.messages) {
    const { owner, repo: repoName, oid, size, operation } = msg.body
    const key = `${owner}/${repoName}`
    if (!seen.has(key)) {
      seen.add(key)
      await repos.upsert(owner, repoName)
    }
    const repo = env.REPO.getByName(key)
    await repo.recordObject(oid, size, operation)
  }
}
