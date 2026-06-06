<script setup lang="ts">
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
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
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import StatusBadge from '@/components/StatusBadge.vue'
import { formatSize, formatTime, formatDate, formatRelative } from '@/lib/format'
import { useRepoMutations } from '@/composables/useRepoMutations'
import type { RepoRow } from '@/composables/useRepos'

defineProps<{ repos: RepoRow[] }>()

const { archive, restore } = useRepoMutations()

// "Stored" = objects present in storage plus pending writes; excludes missing/deleted/purged.
const storedCount = (r: RepoRow) => r.usage.present.count + r.usage.pending.count
const storedSize = (r: RepoRow) => r.usage.present.size + r.usage.pending.size
</script>

<template>
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Repo</TableHead>
        <TableHead>Status</TableHead>
        <TableHead class="text-right">Size</TableHead>
        <TableHead class="text-right">Objects</TableHead>
        <TableHead>Last accessed</TableHead>
        <TableHead>Will archive</TableHead>
        <TableHead class="text-right">Actions</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow v-for="r in repos" :key="`${r.owner}/${r.repo}`">
        <TableCell class="font-mono whitespace-normal break-all">{{ r.owner }}/{{ r.repo }}</TableCell>
        <TableCell><StatusBadge :status="r.status" /></TableCell>
        <TableCell class="text-right">{{ formatSize(storedSize(r)) }}</TableCell>
        <TableCell class="text-right">{{ storedCount(r) }}</TableCell>
        <TableCell>
          <span v-if="r.lastAccessedAt" :title="formatTime(r.lastAccessedAt)">{{ formatRelative(r.lastAccessedAt) }}</span>
          <template v-else>—</template>
        </TableCell>
        <TableCell>
          <Badge v-if="r.archivedAt" variant="destructive" :title="`Blocked since ${formatTime(r.archivedAt)}`">archived</Badge>
          <span v-else-if="r.willArchiveAt" :title="formatTime(r.willArchiveAt)">{{ formatDate(r.willArchiveAt) }}</span>
          <template v-else>—</template>
        </TableCell>
        <TableCell class="text-right">
          <AlertDialog v-if="r.status === 'missing' && !r.archivedAt">
            <AlertDialogTrigger as-child>
              <Button size="xs" variant="destructive" :disabled="archive.isPending.value">Archive</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Archive {{ r.owner }}/{{ r.repo }}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Blocks LFS access — uploads and downloads return 404. Live storage is
                  retained, the status stays <code>missing</code>, and the block is lifted
                  automatically if the repo reappears on GitHub.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" @click="archive.mutate({ owner: r.owner, repo: r.repo })">
                  Archive
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog v-else-if="r.archivedAt">
            <AlertDialogTrigger as-child>
              <Button size="xs" variant="outline" :disabled="restore.isPending.value">Restore</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Restore {{ r.owner }}/{{ r.repo }}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Unblocks LFS access — the repo serves again. Only the block is lifted;
                  the status is unchanged (presence is reconciliation's call).
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction @click="restore.mutate({ owner: r.owner, repo: r.repo })">
                  Restore
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </TableCell>
      </TableRow>
    </TableBody>
  </Table>
</template>
