<script setup lang="ts">
import StorageTable from '@/components/StorageTable.vue';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { useStorage } from '@/composables/useStorage';

const { data: storage, isLoading, error } = useStorage();
</script>

<template>
  <section class="space-y-4">
    <header class="flex items-center justify-between">
      <h2 class="text-2xl font-semibold tracking-tight">Storage</h2>
    </header>

    <Alert v-if="error" variant="destructive">
      <AlertTitle>Failed to load</AlertTitle>
      <AlertDescription>{{ error.message }}</AlertDescription>
    </Alert>

    <div v-else-if="isLoading" class="space-y-2">
      <Skeleton v-for="i in 5" :key="i" class="h-10 w-full" />
    </div>

    <p v-else-if="!storage || storage.length === 0" class="text-muted-foreground">
      No storage discovered yet.
    </p>

    <StorageTable v-else :storage="storage" />
  </section>
</template>
