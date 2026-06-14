import { describe, expect, it } from 'vitest';

import router from '@/router';

describe('router', () => {
  it('redirects / to /storage', async () => {
    await router.push('/');
    await router.isReady();
    expect(router.currentRoute.value.path).toBe('/storage');
  });

  it('loads the ReposPage chunk on navigation to /repos', async () => {
    await router.push('/repos');
    await router.isReady();
    expect(router.currentRoute.value.path).toBe('/repos');
    expect(router.currentRoute.value.matched[0].components?.default).toBeDefined();
  });

  it('resolves /repos to ReposPage chunk', () => {
    const route = router.resolve('/repos');
    expect(route.matched).toHaveLength(1);
    expect(route.matched[0].components?.default).toBeDefined();
  });

  it('resolves /storage to StoragePage chunk', () => {
    const route = router.resolve('/storage');
    expect(route.matched).toHaveLength(1);
    expect(route.matched[0].components?.default).toBeDefined();
  });
});
