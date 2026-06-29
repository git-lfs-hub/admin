import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/storage' },
    {
      path: '/storage',
      component: () => import('./pages/StoragePage.vue'),
    },
    {
      path: '/repos',
      component: () => import('./pages/ReposPage.vue'),
    },
    {
      path: '/repos/:owner/:repo/branches',
      component: () => import('./pages/BranchesPage.vue'),
    },
  ],
});

export default router;
