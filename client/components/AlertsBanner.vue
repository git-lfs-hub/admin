<script setup lang="ts">
import { computed, ref } from 'vue';

import AlertsPanel from '@/components/AlertsPanel.vue';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useAlerts } from '@/composables/useAlerts';

const { data } = useAlerts();
const list = computed(() => data.value?.alerts ?? []);
const slackError = computed(() => data.value?.slackError ?? null);

const dismissed = ref(false);
const open = ref(false);
const show = computed(() => !dismissed.value && (list.value.length > 0 || slackError.value));
</script>

<template>
  <Alert v-if="show" class="mb-4">
    <AlertTitle class="flex items-center justify-between gap-2">
      <button class="hover:underline" type="button" @click="open = !open">
        {{ list.length }} notification{{ list.length === 1 ? '' : 's' }}
      </button>
      <Button variant="ghost" size="sm" @click="dismissed = true">Dismiss</Button>
    </AlertTitle>
    <AlertDescription v-if="slackError" class="mt-1 text-destructive">
      ⚠ Slack delivery failing: {{ slackError.message }} — notifications are in-app only until
      fixed.
    </AlertDescription>
    <AlertsPanel v-if="open && list.length" :alerts="list" class="mt-2" />
  </Alert>
</template>
