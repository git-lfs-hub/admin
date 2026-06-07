import { describe, expect, it } from 'vitest';

import router from '@/router';

describe('router', () => {
  it('redirects / to /repos', async () => {
    await router.push('/');
    await router.isReady();
    expect(router.currentRoute.value.path).toBe('/repos');
  });

  it('resolves /repos to ReposPage chunk', () => {
    const route = router.resolve('/repos');
    expect(route.matched).toHaveLength(1);
    expect(route.matched[0].components?.default).toBeDefined();
  });
});
