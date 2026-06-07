import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/repos' },
    {
      path: '/repos',
      component: () => import('./pages/ReposPage.vue'),
    },
  ],
});

export default router;
