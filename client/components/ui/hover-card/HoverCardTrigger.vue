<script setup lang="ts">
import type { HoverCardTriggerProps } from 'reka-ui';
import { HoverCardTrigger, injectHoverCardRootContext } from 'reka-ui';

const props = defineProps<HoverCardTriggerProps>();

// A press on the trigger is an intentional action (e.g. opening the confirm popover), not hovering —
// dismiss the info card so it doesn't linger inconsistently over the popover.
const rootContext = injectHoverCardRootContext();
</script>

<template>
  <!-- reka only auto-closes on leave while the card is still in its open-delay; once open it hands off
       to the content grace-area, which never fires when the pointer darts to empty space or another
       row, so cards linger and stack. These are info-only cards (entering them dismisses too), so
       force-dismiss on every trigger leave. -->
  <HoverCardTrigger
    data-slot="hover-card-trigger"
    v-bind="props"
    @pointerdown="rootContext.onClose()"
    @pointerleave="rootContext.onDismiss()"
  >
    <slot />
  </HoverCardTrigger>
</template>
