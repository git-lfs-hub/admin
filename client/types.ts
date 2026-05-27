export type RepoStatus = 'active' | 'missing' | 'deleted' | 'purged'

export interface RepoRow {
  owner: string
  repo: string
  status: RepoStatus
  firstSeen: string
  updatedAt: string
  missingAt: string | null
  deletedAt: string | null
  earliestPurge: string | null
  objectCount: number | null
  totalSize: number | null
}
