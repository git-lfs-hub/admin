<script setup lang="ts">
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import StatusBadge from '@/components/StatusBadge.vue'
import { formatSize, formatTime, formatRelative } from '@/lib/format'
import type { RepoRow } from '@/composables/useRepos'

defineProps<{ repos: RepoRow[] }>()
defineEmits<{ changed: [] }>()

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
        <TableHead>Will purge</TableHead>
        <TableHead class="w-32" />
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow v-for="r in repos" :key="`${r.owner}/${r.repo}`">
        <TableCell class="font-mono">{{ r.owner }}/{{ r.repo }}</TableCell>
        <TableCell><StatusBadge :status="r.status" /></TableCell>
        <TableCell class="text-right">{{ formatSize(storedSize(r)) }}</TableCell>
        <TableCell class="text-right">{{ storedCount(r) }}</TableCell>
        <TableCell>
          <span v-if="r.lastAccessedAt" :title="formatTime(r.lastAccessedAt)">{{ formatRelative(r.lastAccessedAt) }}</span>
          <template v-else>—</template>
        </TableCell>
        <TableCell>{{ r.willPurgeAt ? formatTime(r.willPurgeAt) : '—' }}</TableCell>
        <TableCell><!-- actions: Phase 2 --></TableCell>
      </TableRow>
    </TableBody>
  </Table>
</template>
