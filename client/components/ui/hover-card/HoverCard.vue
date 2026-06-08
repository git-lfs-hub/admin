<script setup lang="ts">
import type { HoverCardRootEmits, HoverCardRootProps } from 'reka-ui';
import { HoverCardRoot, useForwardPropsEmits } from 'reka-ui';

// closeDelay 0: these are info-only cards. Combined with `pointer-events-none` on the content,
// leaving the trigger — which includes moving the pointer onto the card — dismisses it at once, so
// it never lingers in the way of reaching another cell.
const props = withDefaults(defineProps<HoverCardRootProps>(), { closeDelay: 0 });
const emits = defineEmits<HoverCardRootEmits>();

const forwarded = useForwardPropsEmits(props, emits);
</script>

<template>
  <HoverCardRoot v-slot="slotProps" data-slot="hover-card" v-bind="forwarded">
    <slot v-bind="slotProps" />
  </HoverCardRoot>
</template>
