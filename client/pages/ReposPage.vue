<script setup lang="ts">
import { useRepos } from '@/composables/useRepos'
import RepoTable from '@/components/RepoTable.vue'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

const { repos, loading, error, reload } = useRepos()
</script>

<template>
  <section class="space-y-4">
    <header class="flex items-center justify-between">
      <h2 class="text-2xl font-semibold tracking-tight">Repositories</h2>
    </header>

    <Alert v-if="error" variant="destructive">
      <AlertTitle>Failed to load</AlertTitle>
      <AlertDescription>{{ error.message }}</AlertDescription>
    </Alert>

    <div v-else-if="loading" class="space-y-2">
      <Skeleton v-for="i in 5" :key="i" class="h-10 w-full" />
    </div>

    <p v-else-if="repos.length === 0" class="text-muted-foreground">
      No repositories discovered yet.
    </p>

    <RepoTable v-else :repos="repos" @changed="reload" />
  </section>
</template>
