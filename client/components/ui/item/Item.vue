<script setup lang="ts">
import { reactiveOmit } from '@vueuse/core';
import { Primitive, type PrimitiveProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';

import { cn } from '@/lib/utils';

import type { ItemVariants } from '.';
import { itemVariants } from '.';

const props = withDefaults(
  defineProps<
    PrimitiveProps & {
      variant?: ItemVariants['variant'];
      size?: ItemVariants['size'];
      class?: HTMLAttributes['class'];
    }
  >(),
  { as: 'div' },
);

const delegatedProps = reactiveOmit(props, 'class', 'variant', 'size');
</script>

<template>
  <Primitive
    data-slot="item"
    :data-variant="variant"
    :data-size="size"
    :class="cn(itemVariants({ variant, size }), props.class)"
    v-bind="delegatedProps"
  >
    <slot />
  </Primitive>
</template>
