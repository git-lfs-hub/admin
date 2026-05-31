import { GithubError, type GithubOrgApi } from "@git-lfs-hub/lib/github";
import type { OrgStatus } from "@/db/_repos-schema";

export type OrgProbeResult =
  | { status: "active"; activeRepos: Set<string>; error?: undefined }
  | { status: Exclude<OrgStatus, "active">; activeRepos?: undefined; error?: string };

/**
 * Probe an org via an installation-authenticated GithubOrgApi: paginate
 * `GET /orgs/{org}/repos` and classify the outcome to OrgStatus.
 * Returns the set of `{owner}/{repo}` (lowercased) keys on success.
 * Never throws. Caller obtains the GithubOrgApi via `app.orgApi(org)` and
 * handles auth failures (no_installation) separately.
 */
export async function probeOrg(api: GithubOrgApi): Promise<OrgProbeResult> {
  const active = new Set<string>();
  try {
    for await (const page of api.listRepos()) {
      for (const r of page) {
        active.add(`${r.owner.login.toLowerCase()}/${r.name.toLowerCase()}`);
      }
    }
  } catch (e) {
    if (e instanceof GithubError) {
      if (e.code === "forbidden") return { status: "forbidden", error: e.message };
      if (e.code === "missing") return { status: "missing", error: e.message };
      return { status: "transient_error", error: e.message };
    }
    return { status: "transient_error", error: e instanceof Error ? e.message : String(e) };
  }

  if (active.size === 0) {
    return { status: "transient_error", error: "empty listing despite 200" };
  }
  return { status: "active", activeRepos: active };
}
