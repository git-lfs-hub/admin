<script setup lang="ts">
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import StatusBadge from '@/components/StatusBadge.vue'
import { formatSize, formatTime } from '@/lib/format'
import type { RepoRow } from '@/composables/useRepos'

defineProps<{ repos: RepoRow[] }>()
defineEmits<{ changed: [] }>()
</script>

<template>
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Repo</TableHead>
        <TableHead>Status</TableHead>
        <TableHead class="text-right">Size</TableHead>
        <TableHead class="text-right">Objects</TableHead>
        <TableHead>Last updated</TableHead>
        <TableHead>Will purge</TableHead>
        <TableHead class="w-32" />
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow v-for="r in repos" :key="`${r.owner}/${r.repo}`">
        <TableCell class="font-mono">{{ r.owner }}/{{ r.repo }}</TableCell>
        <TableCell><StatusBadge :status="r.status" /></TableCell>
        <TableCell class="text-right">{{ r.totalSize != null ? formatSize(r.totalSize) : '—' }}</TableCell>
        <TableCell class="text-right">{{ r.objectCount ?? '—' }}</TableCell>
        <TableCell>{{ formatTime(r.updatedAt) }}</TableCell>
        <TableCell>{{ r.willPurgeAt ? formatTime(r.willPurgeAt) : '—' }}</TableCell>
        <TableCell><!-- actions: Phase 2 --></TableCell>
      </TableRow>
    </TableBody>
  </Table>
</template>
