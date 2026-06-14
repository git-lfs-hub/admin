<script setup lang="ts">
import { Primitive, type PrimitiveProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';

import { cn } from '@/lib/utils';

const props = withDefaults(defineProps<PrimitiveProps & { class?: HTMLAttributes['class'] }>(), {
  as: 'div',
});
</script>

<template>
  <Primitive
    data-slot="item-title"
    :as="as"
    :as-child="asChild"
    :class="cn('flex w-fit items-center gap-2 text-sm leading-snug font-medium', props.class)"
  >
    <slot />
  </Primitive>
</template>
