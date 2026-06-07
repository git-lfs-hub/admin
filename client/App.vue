<script setup lang="ts">
import AppHeader from '@/components/AppHeader.vue';
import { Toaster } from '@/components/ui/sonner';
</script>

<template>
  <AppHeader />
  <main class="container mx-auto p-4">
    <RouterView />
  </main>
  <Toaster />
</template>
