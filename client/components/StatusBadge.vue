<script setup lang="ts">
import { Badge } from '@/components/ui/badge'
import type { RepoStatus } from '@/types'

const props = defineProps<{ status: RepoStatus }>()

const variant = {
  active:  'default',
  missing: 'secondary',
  deleted: 'destructive',
  purged:  'outline',
} as const
</script>

<template>
  <Badge :variant="variant[props.status]">{{ props.status }}</Badge>
</template>
