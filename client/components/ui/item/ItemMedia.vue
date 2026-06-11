<script setup lang="ts">
import { reactiveOmit } from '@vueuse/core';
import { Primitive, type PrimitiveProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';

import { cn } from '@/lib/utils';

import type { ItemMediaVariants } from '.';
import { itemMediaVariants } from '.';

const props = withDefaults(
  defineProps<
    PrimitiveProps & {
      variant?: ItemMediaVariants['variant'];
      class?: HTMLAttributes['class'];
    }
  >(),
  { as: 'div' },
);

const delegatedProps = reactiveOmit(props, 'class', 'variant');
</script>

<template>
  <Primitive
    data-slot="item-media"
    :data-variant="variant"
    :class="cn(itemMediaVariants({ variant }), props.class)"
    v-bind="delegatedProps"
  >
    <slot />
  </Primitive>
</template>
