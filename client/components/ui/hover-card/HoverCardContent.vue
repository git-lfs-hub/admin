<script setup lang="ts">
import { reactiveOmit } from '@vueuse/core';
import type { HoverCardContentProps } from 'reka-ui';
import {
  HoverCardContent,
  HoverCardPortal,
  injectHoverCardRootContext,
  useForwardProps,
} from 'reka-ui';
import type { HTMLAttributes } from 'vue';

import { cn } from '@/lib/utils';

defineOptions({
  inheritAttrs: false,
});

const props = withDefaults(
  defineProps<HoverCardContentProps & { class?: HTMLAttributes['class'] }>(),
  {
    align: 'center',
    sideOffset: 4,
  },
);

const delegatedProps = reactiveOmit(props, 'class');

const forwardedProps = useForwardProps(delegatedProps);

// These are info-only cards: hovering the card itself should dismiss it so it never blocks the path
// to another cell. reka's content keeps the card open on pointer-enter (the grace-area corridor);
// intercept that in the capture phase, stop reka's reopen, and dismiss instead.
const rootContext = injectHoverCardRootContext();
function dismissOnEnter(e: PointerEvent) {
  e.stopImmediatePropagation();
  rootContext.onDismiss();
}
</script>

<template>
  <HoverCardPortal>
    <HoverCardContent
      data-slot="hover-card-content"
      v-bind="{ ...$attrs, ...forwardedProps }"
      @pointerenter.capture="dismissOnEnter"
      :class="
        cn(
          'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 bg-popover text-popover-foreground w-64 rounded-lg p-2.5 text-sm shadow-md ring-1 duration-100 z-50 origin-(--reka-hover-card-content-transform-origin) outline-hidden',
          props.class,
        )
      "
    >
      <slot />
    </HoverCardContent>
  </HoverCardPortal>
</template>
