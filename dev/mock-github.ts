import { devPresentRepos, devLinks } from '@dev/github';
import { orgsFromEnv } from '@git-lfs-hub/lib/auth';
import type { GithubApi, GithubOrgApi, RepoScan } from '@git-lfs-hub/lib/github';

// Stand-in for `GithubApi.forApp` so real `reconcileRepos` runs locally. Repos attach to the primary
// allowed org so they survive reconcile's allow-filter in any env (local `acme`, test `test-org`).
export function mockGithubApp(env: CloudflareBindings): GithubApi {
  const primary = orgsFromEnv(env)[0];
  const installs = primary ? [{ login: primary, id: 1 }] : [];
  return {
    async installedOrgs() {
      return installs;
    },
    async orgApi(account: { login: string; id: number }) {
      return mockOrgApi(env, account.login);
    },
  } as unknown as GithubApi;
}

function mockOrgApi(env: CloudflareBindings, org: string): GithubOrgApi {
  return {
    org,
    async *scanRepos(): AsyncIterable<RepoScan[]> {
      yield devScans(env, org, devPresentRepos, devLinks);
    },
  } as unknown as GithubOrgApi;
}

// A mapped repo gets a `local`/`ok` `.lfsconfig`; an unmapped one gets none (→ no link → `unused`).
export function devScans(
  env: CloudflareBindings,
  org: string,
  repos: string[],
  links: Record<string, string>,
): RepoScan[] {
  return repos.map((name) => {
    const prefix = links[name] ? `${org}/${links[name]}` : null;
    return {
      owner: org,
      name,
      branch: 'main',
      headSha: `dev-head-${org}/${name}`,
      lfsconfig: prefix ? { oid: `dev-oid-${prefix}`, text: devLfsconfig(env, prefix) } : null,
    };
  });
}

// `lfs.url` must target this deployment's server so the scan classifies the prefix `local`.
function devLfsconfig(env: CloudflareBindings, prefix: string): string {
  return `[lfs]\n\turl = https://${env.LFS.server}/lfs/${prefix}\n`;
}
