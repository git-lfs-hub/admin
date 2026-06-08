<script setup lang="ts">
import { Badge } from '@/components/ui/badge';
import type { RepoStatus } from '@/composables/useRepos';

const props = defineProps<{ status: RepoStatus }>();

const variant = {
  used: 'default',
  unused: 'secondary',
  purged: 'outline',
} as const satisfies Record<RepoStatus, string>;
</script>

<template>
  <Badge :variant="variant[props.status]">{{ props.status }}</Badge>
</template>
