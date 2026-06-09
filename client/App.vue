<script setup lang="ts">
import AlertsBanner from '@/components/AlertsBanner.vue';
import AppHeader from '@/components/AppHeader.vue';
import { Toaster } from '@/components/ui/sonner';
</script>

<template>
  <AppHeader />
  <main class="container mx-auto p-4">
    <AlertsBanner />
    <RouterView />
  </main>
  <Toaster />
</template>
