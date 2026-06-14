<script setup lang="ts">
import { Separator } from 'reka-ui';
import type { HTMLAttributes } from 'vue';

import { cn } from '@/lib/utils';

const props = defineProps<{ class?: HTMLAttributes['class'] }>();
</script>

<template>
  <Separator data-slot="item-separator" orientation="horizontal" :class="cn('my-0', props.class)" />
</template>
