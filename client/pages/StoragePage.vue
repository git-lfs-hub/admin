<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

import StorageTable from '@/components/StorageTable.vue';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { useLiveUpdates } from '@/composables/useLiveUpdates';
import { useStorage } from '@/composables/useStorage';

const { data: storage, isLoading, error } = useStorage();
// Storage lifecycle shifts both the rows and their derived alerts.
useLiveUpdates({ storage: [['storage'], ['alerts']] });

const route = useRoute();
const highlight = computed(() =>
  typeof route.query.highlight === 'string' ? route.query.highlight : undefined,
);
</script>

<template>
  <section class="space-y-4">
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

    <StorageTable v-else :storage="storage" :highlight="highlight" />
  </section>
</template>
