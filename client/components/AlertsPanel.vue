<script setup lang="ts">
import { Badge } from '@/components/ui/badge';
import type { Alert } from '@/composables/useAlerts';
import { formatRelative, formatTime } from '@/lib/format';

defineProps<{ alerts: Alert[] }>();

// Client-local copy (not imported from worker/alerts/message.ts) to avoid pulling the worker
// DB schema into the SPA bundle.
const LABEL: Record<Alert['kind'], string> = {
  missing: 'Storage unused — no live repository',
  reappeared: 'Storage back in use',
  archived: 'Storage archived — serving blocked',
  restored: 'Storage restored — serving resumed',
};

// Strip the scope namespace for display (`storage:acme/app` → `acme/app`).
const label = (scope: string) => scope.slice(scope.indexOf(':') + 1);
</script>

<template>
  <ul class="divide-y rounded-lg border">
    <li v-for="a in alerts" :key="`${a.scope}:${a.kind}`" class="flex flex-col gap-1 p-2 text-sm">
      <!-- Line 1: storage prefix, with the relative time + kind badge on the right. -->
      <div class="flex items-center justify-between gap-2">
        <span class="truncate font-mono">{{ label(a.scope) }}</span>
        <span class="flex shrink-0 items-center gap-2">
          <span class="text-muted-foreground" :title="formatTime(a.updatedAt)">{{
            formatRelative(a.updatedAt)
          }}</span>
          <Badge :variant="a.severity === 'warning' ? 'secondary' : 'outline'" class="h-6">{{
            a.kind
          }}</Badge>
        </span>
      </div>
      <!-- Line 2: the human description. -->
      <span class="text-muted-foreground">{{ LABEL[a.kind] }}</span>
    </li>
  </ul>
</template>
