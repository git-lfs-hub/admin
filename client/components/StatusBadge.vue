<script setup lang="ts">
import type { HTMLAttributes } from 'vue';

import { Badge } from '@/components/ui/badge';
import type { RepoStatus } from '@/composables/useRepos';
import type { StorageStatus } from '@/composables/useStorage';

const props = defineProps<{
  status: RepoStatus | StorageStatus;
  class?: HTMLAttributes['class'];
}>();

const variant = {
  // git presence (`repos`)
  active: 'outline',
  missing: 'secondary',
  // storage lifecycle (`storage`)
  used: 'outline',
  unused: 'secondary',
  purged: 'outline',
} as const satisfies Record<RepoStatus | StorageStatus, string>;
</script>

<template>
  <Badge :variant="variant[props.status]" :class="props.class">{{ props.status }}</Badge>
</template>
