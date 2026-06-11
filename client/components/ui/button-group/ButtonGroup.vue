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
    data-slot="button-group"
    role="group"
    :as="as"
    :as-child="asChild"
    :class="
      cn(
        'flex w-fit items-stretch [&>*]:relative [&>*:focus-visible]:z-10 [&>*:not(:first-child)]:rounded-l-none [&>*:not(:first-child)]:border-l-0 [&>*:not(:last-child)]:rounded-r-none',
        props.class,
      )
    "
  >
    <slot />
  </Primitive>
</template>
