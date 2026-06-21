import { devPresentRepos, devLinks } from '@dev/github';
import { orgsFromEnv } from '@git-lfs-hub/lib/auth';
import type {
  BranchHead,
  GithubApi,
  GithubOrgApi,
  RepoScan,
  TreeEntry,
} from '@git-lfs-hub/lib/github';

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

// A dev repo has one branch (`main`) tracking one LFS blob, so reconcileBranches runs the
// real resolve pipeline locally: listBranches → listBlobs → getBlobs (pointer parse) → ref_paths.
function mockOrgApi(env: CloudflareBindings, org: string): GithubOrgApi {
  // 64-hex so the real pointer parser accepts it (derived from org/repo, not random).
  const devOid = (repo: string) =>
    [...`${org}/${repo}`]
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('')
      .padEnd(64, '0')
      .slice(0, 64);
  return {
    org,
    async *scanRepos(): AsyncIterable<RepoScan[]> {
      yield devScans(env, org, devPresentRepos, devLinks);
    },
    async listBranches(repo: string): Promise<{ branches: BranchHead[]; rateLimit: null }> {
      return {
        branches: [
          {
            branch: 'main',
            headSha: `dev-head-${org}/${repo}`,
            treeSha: `dev-tree-${org}/${repo}`,
          },
        ],
        rateLimit: null,
      };
    },
    async listBlobs(repo: string): Promise<TreeEntry[]> {
      return [
        { path: '.gitattributes', type: 'blob', sha: `dev-ga-${repo}` },
        { path: 'assets/logo.bin', type: 'blob', sha: `dev-blob-${repo}` },
      ];
    },
    async getBlobs(repo: string, oids: string[]): Promise<Map<string, { text: string | null }>> {
      const m = new Map<string, { text: string | null }>();
      for (const o of oids) {
        if (o === `dev-ga-${repo}`) m.set(o, { text: '*.bin filter=lfs\n' });
        else if (o === `dev-blob-${repo}`) m.set(o, { text: devPointer(devOid(repo)) });
      }
      return m;
    },
    async getFile(repo: string, path: string) {
      if (path !== '.lfsconfig') return null;
      const prefix = devLinks[repo] ? `${org}/${devLinks[repo]}` : null;
      return prefix ? { sha: `dev-oid-${prefix}`, text: devLfsconfig(env, prefix) } : null;
    },
  } as unknown as GithubOrgApi;
}

function devPointer(oid: string): string {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 42\n`;
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
