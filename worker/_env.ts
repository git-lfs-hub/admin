import type { GithubApi } from '@git-lfs-hub/lib/github';

export type AppEnv = {
  Bindings: CloudflareBindings;
  // `adminOrgs`: orgs the caller admins (drives per-org mutation scoping). `api`: caller's
  // GithubApi (absent in local-dev bypass).
  Variables: { admin: string; adminOrgs: string[]; api: GithubApi };
};
