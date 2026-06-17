import type { GithubOrgApi, RepoScan } from '@git-lfs-hub/lib/github';

import type { OrgStatus } from '@/db/registry-schema';

export type OrgProbeResult =
  | { status: 'active'; activeRepos: Set<string>; scans: RepoScan[]; error?: undefined }
  | {
      status: Exclude<OrgStatus, 'active'>;
      activeRepos?: undefined;
      scans?: undefined;
      error?: string;
    };

/**
 * Probe an installation via one bulk GraphQL sweep (`scanRepos`): the lowercased `{owner}/{repo}`
 * presence set plus the raw per-repo scans (head + `.lfsconfig` inline) in one pass. Throws on
 * listing failure — the caller maps the error to an OrgStatus.
 */
export async function probeOrg(api: GithubOrgApi): Promise<OrgProbeResult> {
  const active = new Set<string>();
  const scans: RepoScan[] = [];
  for await (const page of api.scanRepos()) {
    for (const r of page) {
      active.add(`${r.owner.toLowerCase()}/${r.name.toLowerCase()}`);
      scans.push(r);
    }
  }
  return active.size === 0
    ? { status: 'transient_error', error: 'empty listing despite 200' }
    : { status: 'active', activeRepos: active, scans };
}
