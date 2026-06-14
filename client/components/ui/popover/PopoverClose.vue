<script setup lang="ts">
import { PopoverClose, type PopoverCloseProps } from 'reka-ui';

const props = defineProps<PopoverCloseProps>();
</script>

<template>
  <PopoverClose data-slot="popover-close" v-bind="props">
    <slot />
  </PopoverClose>
</template>
