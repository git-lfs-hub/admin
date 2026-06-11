<script setup lang="ts">
import RepoTable from '@/components/RepoTable.vue';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { useRepos } from '@/composables/useRepos';

const { data: repos, isLoading, error } = useRepos();
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

    <p v-else-if="!repos || repos.length === 0" class="text-muted-foreground">
      No repositories discovered yet.
    </p>

    <RepoTable v-else :repos="repos" />
  </section>
</template>
