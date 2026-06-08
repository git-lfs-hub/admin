<script setup lang="ts">
import { RouterLink } from 'vue-router';

import StatusBadge from '@/components/StatusBadge.vue';
import { Badge } from '@/components/ui/badge';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { RepoRow } from '@/composables/useRepos';
import { formatTime, formatRelative } from '@/lib/format';

defineProps<{ repos: RepoRow[] }>();
</script>

<template>
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Repo</TableHead>
        <TableHead>Storage</TableHead>
        <TableHead>Status</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow v-for="r in repos" :key="`${r.owner}/${r.repo}`">
        <TableCell class="font-mono whitespace-normal break-all"
          >{{ r.owner }}/{{ r.repo }}</TableCell
        >

        <!-- Inferred storage prefix. `used`/`unused` are implied by the repo status, so only the
             notable storage states (`purged`, `archived`) are badged here. -->
        <TableCell>
          <span v-if="r.storage" class="inline-flex items-center gap-2">
            <RouterLink to="/storage" class="font-mono hover:underline">{{
              r.storage.prefix
            }}</RouterLink>
            <HoverCard v-if="r.storage.status === 'purged'">
              <HoverCardTrigger as-child>
                <StatusBadge :status="r.storage.status" class="h-6" />
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
                <Badge variant="destructive" class="h-6">archived</Badge>
              </HoverCardTrigger>
              <HoverCardContent class="w-auto space-y-2">
                <p class="font-medium">Archived {{ formatRelative(r.storage.archivedAt) }}</p>
                <p class="text-muted-foreground">
                  {{ formatTime(r.storage.archivedAt) }} — this storage no longer serves Git LFS.
                  Files are kept; nothing is deleted.
                </p>
              </HoverCardContent>
            </HoverCard>
          </span>
          <span v-else class="text-muted-foreground">—</span>
        </TableCell>

        <!-- Status merges the repo's GitHub presence with its "missing since" age. -->
        <TableCell>
          <HoverCard>
            <HoverCardTrigger as-child>
              <span class="inline-flex items-center gap-2">
                <StatusBadge :status="r.status" class="h-6" />
                <span v-if="r.status === 'missing' && r.missingAt" class="text-muted-foreground"
                  >since {{ formatRelative(r.missingAt) }}</span
                >
              </span>
            </HoverCardTrigger>
            <HoverCardContent class="w-auto">
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
        </TableCell>
      </TableRow>
    </TableBody>
  </Table>
</template>
