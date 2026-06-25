<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { useBranches, useBranchMutations, type Branch } from '@/composables/useBranches';
import { formatRelative, formatSize, formatTime, formatUntil } from '@/lib/format';

const route = useRoute();
const owner = route.params.owner as string;
const repo = route.params.repo as string;

const { data: branches, isLoading, error } = useBranches(owner, repo);
const { remove, undelete } = useBranchMutations(owner, repo);

// `deleted` adds to the git statuses; the storage-flavoured StatusBadge doesn't cover it.
const BADGE = {
  active: 'outline',
  missing: 'secondary',
  deleted: 'destructive',
} as const satisfies Record<Branch['status'], string>;

const sorted = computed(() =>
  [...(branches.value ?? [])].sort((a, b) => a.branch.localeCompare(b.branch)),
);
</script>

<template>
  <section class="space-y-4">
    <div class="flex items-baseline gap-2">
      <RouterLink to="/repos" class="text-muted-foreground hover:underline"
        >Repositories</RouterLink
      >
      <span class="text-muted-foreground">/</span>
      <h1 class="font-mono break-all">{{ owner }}/{{ repo }}</h1>
    </div>

    <Alert v-if="error" variant="destructive">
      <AlertTitle>Failed to load</AlertTitle>
      <AlertDescription>{{ error.message }}</AlertDescription>
    </Alert>

    <div v-else-if="isLoading" class="space-y-2">
      <Skeleton v-for="i in 4" :key="i" class="h-12 w-full" />
    </div>

    <p v-else-if="sorted.length === 0" class="text-muted-foreground">No branches tracked yet.</p>

    <ItemGroup v-else class="gap-2">
      <Item v-for="b in sorted" :key="b.branch" variant="outline" class="items-start">
        <ItemContent>
          <div class="flex items-center justify-between gap-4">
            <ItemTitle class="font-mono break-all">{{ b.branch }}</ItemTitle>
            <Badge :variant="BADGE[b.status]" class="h-6 shrink-0">{{ b.status }}</Badge>
          </div>

          <ItemDescription class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <!-- local: the storage prefix the branch references; external: just the host mapping. -->
            <span v-if="b.lfsconfig?.local" class="font-mono text-foreground">{{
              b.lfsconfig.prefix
            }}</span>
            <span v-else-if="b.lfsconfig" class="inline-flex items-center gap-1">
              <Badge variant="outline" class="h-5">external</Badge>
              <span class="font-mono">{{ b.lfsconfig.host }}</span>
            </span>
            <span v-else class="text-muted-foreground">no .lfsconfig</span>

            <span>{{ b.oidCount }} objects</span>
            <span v-if="b.prefixUsage"
              >{{ formatSize(b.prefixUsage.total.size) }} total<template
                v-if="b.prefixUsage.blocked.count"
              >
                · {{ formatSize(b.prefixUsage.blocked.size) }} blocked</template
              ></span
            >
            <span v-if="b.scannedAt" :title="formatTime(b.scannedAt)"
              >scanned {{ formatRelative(b.scannedAt) }}</span
            >
            <span v-else class="text-muted-foreground">never scanned</span>
            <span v-if="b.deletedAt && b.willPurgeAt" class="text-muted-foreground"
              >purges {{ formatUntil(b.willPurgeAt) }}</span
            >
          </ItemDescription>
        </ItemContent>

        <!-- Actions only for local prefixes; external branches show the mapping, no delete. -->
        <div v-if="b.lfsconfig?.local" class="shrink-0 self-center">
          <Button
            v-if="b.status === 'deleted'"
            size="sm"
            variant="outline"
            :disabled="undelete.isPending.value"
            @click="undelete.mutate(b.branch)"
            >Undelete</Button
          >
          <AlertDialog v-else>
            <AlertDialogTrigger as-child>
              <Button size="sm" variant="outline" :disabled="b.dirty">Delete</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle
                  >Delete branch <span class="font-mono">{{ b.branch }}</span
                  >?</AlertDialogTitle
                >
                <AlertDialogDescription>
                  The branch forfeits its references on
                  <span class="font-mono">{{ b.lfsconfig.prefix }}</span
                  >. Objects no other live branch references are blocked and purged after the
                  retention window. Reversible until purged.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" @click="remove.mutate(b.branch)"
                  >Delete</AlertDialogAction
                >
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </Item>
    </ItemGroup>
  </section>
</template>
