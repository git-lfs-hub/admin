<script setup lang="ts">
import { RouterLink } from 'vue-router';

import { useAuth } from '@/composables/useAuth';
const { admin } = useAuth();
</script>

<template>
  <header class="border-b">
    <div class="container mx-auto flex items-center justify-between p-4">
      <RouterLink to="/repos" class="text-xl font-bold">lfs-admin</RouterLink>
      <nav class="flex items-center gap-4 text-sm">
        <RouterLink to="/repos" class="hover:underline">Repos</RouterLink>
        <span v-if="admin" class="text-muted-foreground">{{ admin }}</span>
      </nav>
    </div>
  </header>
</template>
