<script setup lang="ts">
import { RouterLink } from 'vue-router';

import StatusBadge from '@/components/StatusBadge.vue';
import { Badge } from '@/components/ui/badge';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import type { RepoRow } from '@/composables/useRepos';
import { formatTime, formatRelative } from '@/lib/format';

defineProps<{ repos: RepoRow[] }>();
</script>

<template>
  <ItemGroup data-slot="repo-list" class="gap-2">
    <template v-for="r in repos" :key="`${r.owner}/${r.repo}`">
      <Item variant="outline" class="items-start">
        <ItemContent>
          <!-- Row 1: repo + its GitHub-presence status badge, vertically centered. The badge merges
               the repo's presence with its "missing since" age. -->
          <div class="flex items-center justify-between gap-4">
            <ItemTitle class="font-mono break-all">{{ r.owner }}/{{ r.repo }}</ItemTitle>

            <div data-slot="status" class="shrink-0">
              <HoverCard>
                <HoverCardTrigger as-child>
                  <span class="inline-flex items-center gap-2">
                    <StatusBadge :status="r.status" class="h-6" />
                    <span v-if="r.status === 'missing' && r.missingAt" class="text-muted-foreground"
                      >since {{ formatRelative(r.missingAt) }}</span
                    >
                  </span>
                </HoverCardTrigger>
                <HoverCardContent side="left" class="w-auto">
                  <template v-if="r.status === 'missing'">
                    <p class="font-medium">
                      Repository missing<template v-if="r.missingAt">
                        since {{ formatTime(r.missingAt) }}</template
                      >
                    </p>
                    <p class="text-muted-foreground">
                      No longer found on GitHub. Its storage is now unused and will be archived
                      automatically.
                    </p>
                  </template>
                  <template v-else>
                    <p class="font-medium">Active</p>
                    <p class="text-muted-foreground">Present on GitHub and serving Git LFS.</p>
                  </template>
                </HoverCardContent>
              </HoverCard>
            </div>
          </div>

          <!-- Row 2: the inferred storage prefix. `used`/`unused` are implied by the repo status, so
               only the notable storage states (`purged`, `archived`) are badged here. -->
          <div class="flex items-start justify-between gap-4">
            <ItemDescription
              data-slot="storage"
              class="flex flex-wrap items-center gap-x-2 gap-y-1"
            >
              <span v-if="r.storage" class="inline-flex items-baseline gap-2">
                <span>Storage</span>
                <RouterLink to="/storage" class="font-mono text-foreground">{{
                  r.storage.prefix
                }}</RouterLink>
                <HoverCard v-if="r.storage.status === 'purged'">
                  <HoverCardTrigger as-child>
                    <StatusBadge :status="r.storage.status" class="h-6 self-center" />
                  </HoverCardTrigger>
                  <HoverCardContent class="w-auto">
                    <p class="font-medium">Purged</p>
                    <p class="text-muted-foreground">
                      Every file in this storage was permanently deleted.
                    </p>
                  </HoverCardContent>
                </HoverCard>
                <HoverCard v-else-if="r.storage.archivedAt">
                  <HoverCardTrigger as-child>
                    <Badge variant="destructive" class="h-6 self-center">archived</Badge>
                  </HoverCardTrigger>
                  <HoverCardContent class="w-auto space-y-2">
                    <p class="font-medium">Archived {{ formatRelative(r.storage.archivedAt) }}</p>
                    <p class="text-muted-foreground">
                      {{ formatTime(r.storage.archivedAt) }} — this storage no longer serves Git
                      LFS.<br />
                      Files are kept; nothing is deleted.
                    </p>
                  </HoverCardContent>
                </HoverCard>
              </span>
              <span v-else>—</span>
            </ItemDescription>
          </div>
        </ItemContent>
      </Item>
    </template>
  </ItemGroup>
</template>
