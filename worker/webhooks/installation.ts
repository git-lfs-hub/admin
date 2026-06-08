import { Registry } from '@/db/registry';
import { reconcileRepoEvent } from '@/reconcile/repos';

// Install-scope webhooks → shared DO path. `installation` sets whole-org state on the orgs
// table; `installation_repositories` flips presence for tracked repos — genuinely new ones are
// left to R2 discovery, not created here.
export type InstallationEvent = {
  action: string;
  installation: { account: { login: string } };
};

export type InstallationRepositoriesEvent = {
  action: string;
  repositories_added?: { full_name: string }[];
  repositories_removed?: { full_name: string }[];
};

const INSTALL_PRESENT = new Set(['created', 'unsuspend']);
const INSTALL_ABSENT = new Set(['deleted', 'suspend']);

export async function handleInstallation(env: CloudflareBindings, payload: InstallationEvent) {
  const present = INSTALL_PRESENT.has(payload.action);
  if (!present && !INSTALL_ABSENT.has(payload.action)) return;
  const registry = Registry.global(env);
  await registry.upsertOrgStatus(
    payload.installation.account.login,
    present ? 'active' : 'no_installation',
  );
}

export async function handleInstallationRepositories(
  env: CloudflareBindings,
  payload: InstallationRepositoriesEvent,
) {
  const registry = Registry.global(env);
  for (const { full_name } of payload.repositories_removed ?? []) {
    const [owner, repo] = full_name.split('/');
    await reconcileRepoEvent(env, registry, owner, repo, false);
  }
  for (const { full_name } of payload.repositories_added ?? []) {
    const [owner, repo] = full_name.split('/');
    await reconcileRepoEvent(env, registry, owner, repo, true);
  }
}
