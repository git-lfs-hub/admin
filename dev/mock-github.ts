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

// `webapp` carries three branches sharing/owning LFS blobs, so the admin branch-deletion flow is
// exercisable locally: deleting `release`/`experiment` orphans its unique blob (→ block), while
// `logo` stays live (still on `main`). Blob OIDs match server/dev/seed.ts so the blocked objects are
// real R2 bytes. Every other repo keeps a single `main` with one stub blob.
const WEBAPP_FILES: Record<string, number> = {
  readme: 1024,
  logo: 2048,
  'font-bold': 4096,
  'font-regular': 3072,
  'bg-image': 8192,
  'release-notes': 4096,
  'prototype-asset': 2048,
};
const WEBAPP_BRANCHES: Record<string, string[]> = {
  main: ['readme', 'logo', 'font-bold', 'font-regular', 'bg-image'],
  release: ['logo', 'release-notes'],
  experiment: ['logo', 'prototype-asset'],
};

// A dev repo's branches each track LFS blobs, so reconcileBranches runs the real resolve pipeline
// locally: listBranches → listBlobs(treeSha) → getBlobs (pointer parse) → ref_paths. The blob set is
// keyed by `treeSha` (`dev-tree-<repo>/<branch>`), not branch name, so same-named branches across
// repos don't collide.
function mockOrgApi(env: CloudflareBindings, org: string): GithubOrgApi {
  return {
    org,
    async *scanRepos(): AsyncIterable<RepoScan[]> {
      yield devScans(env, org, devPresentRepos, devLinks);
    },
    async listBranches(repo: string): Promise<{ branches: BranchHead[]; rateLimit: null }> {
      const names = repo === 'webapp' ? Object.keys(WEBAPP_BRANCHES) : ['main'];
      return {
        branches: names.map((branch) => ({
          branch,
          headSha: `dev-head-${repo}/${branch}`,
          treeSha: `dev-tree-${repo}/${branch}`,
        })),
        rateLimit: null,
      };
    },
    async listBlobs(_repo: string, treeSha: string): Promise<TreeEntry[]> {
      return [
        { path: '.gitattributes', type: 'blob', sha: 'dev-ga' },
        ...filesForTree(treeSha).map((seed) => ({
          path: `${seed}.bin`,
          type: 'blob' as const,
          sha: `dev-blob-${treeSha}/${seed}`,
        })),
      ];
    },
    async getBlobs(_repo: string, shas: string[]): Promise<Map<string, { text: string | null }>> {
      const m = new Map<string, { text: string | null }>();
      for (const sha of shas) {
        if (sha === 'dev-ga') m.set(sha, { text: '*.bin filter=lfs\n' });
        else m.set(sha, { text: devPointer(await blobOid(org, sha)) });
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

// `dev-tree-<repo>/<branch>` → the LFS seeds that tree holds. Only `webapp` is multi-blob; any other
// tree is a single stub blob named for its repo (preserving the one-blob-per-repo default).
function filesForTree(treeSha: string): string[] {
  const [repo, branch] = treeSha.replace('dev-tree-', '').split('/');
  if (repo === 'webapp') return WEBAPP_BRANCHES[branch] ?? [];
  return [`${repo}-asset`];
}

// A blob sha (`dev-blob-<treeSha>/<seed>`) → its LFS oid. A `webapp` seed gets the *real* server-seed
// oid so the blocked object exists in R2; anything else gets a deterministic stub oid.
async function blobOid(org: string, sha: string): Promise<string> {
  const [repo, , seed] = sha.replace('dev-blob-dev-tree-', '').split('/');
  if (repo === 'webapp') return seededOid(org, 'webapp', seed, WEBAPP_FILES[seed]!);
  return [...sha]
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padEnd(64, '0')
    .slice(0, 64);
}

// Mirror server/dev/seed.lib.ts `sha256hex(generateContent(...))` with Web Crypto so a webapp branch
// references the exact oid the seed wrote to R2.
async function seededOid(owner: string, repo: string, seed: string, size: number): Promise<string> {
  const h = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${owner}/${repo}/${seed}`)),
  );
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) buf[i] = h[i % h.length]!;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
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
