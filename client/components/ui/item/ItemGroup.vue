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
    data-slot="item-group"
    role="list"
    :as="as"
    :as-child="asChild"
    :class="cn('flex flex-col', props.class)"
  >
    <slot />
  </Primitive>
</template>
