import type { GithubOrgApi } from "@git-lfs-hub/lib/github";
import type { OrgStatus } from "@/db/repos-schema";

export type OrgProbeResult =
  | { status: "active"; activeRepos: Set<string>; error?: undefined }
  | { status: Exclude<OrgStatus, "active">; activeRepos?: undefined; error?: string };

/**
 * Probe an org via an installation-authenticated GithubOrgApi: paginate
 * `GET /orgs/{org}/repos` into a set of lowercased `{owner}/{repo}` keys.
 * Throws on listing failure — the caller maps the error to an OrgStatus.
 */
export async function probeOrg(api: GithubOrgApi): Promise<OrgProbeResult> {
  const active = new Set<string>();
  for await (const page of api.listRepos()) {
    for (const r of page) {
      active.add(`${r.owner.login.toLowerCase()}/${r.name.toLowerCase()}`);
    }
  }

  if (active.size === 0) {
    return { status: "transient_error", error: "empty listing despite 200" };
  }
  return { status: "active", activeRepos: active };
}
