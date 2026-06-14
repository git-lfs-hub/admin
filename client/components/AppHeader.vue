<script setup lang="ts">
import { isSystem, systemCopy } from '@worker/alerts/health';
import { Bell, RefreshCw } from 'lucide-vue-next';
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import AlertsPanel from '@/components/AlertsPanel.vue';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAlerts } from '@/composables/useAlerts';
import { useAuth } from '@/composables/useAuth';
import { useReconcile } from '@/composables/useReconcile';

const { admin } = useAuth();

// Section tabs double as nav: bound to the current route, switching pushes it.
const route = useRoute();
const router = useRouter();
const section = computed(() => (route.path.startsWith('/repos') ? 'repos' : 'storage'));
const go = (value: string | number) => router.push(`/${value}`);

const reconcile = useReconcile();

const { data } = useAlerts();
const all = computed(() => data.value?.alerts ?? []);
const list = computed(() => all.value.filter((a) => !isSystem(a.scope)));
// `system:*` scopes are global health (e.g. Slack delivery), rendered apart from the resource list.
const systemAlerts = computed(() => all.value.filter((a) => isSystem(a.scope)));
const hasAny = computed(() => all.value.length > 0);
</script>

<template>
  <header class="border-b">
    <div class="container mx-auto flex items-center justify-between p-4">
      <Tabs :model-value="section" @update:model-value="go">
        <TabsList>
          <TabsTrigger value="storage">Storage</TabsTrigger>
          <TabsTrigger value="repos">Repos</TabsTrigger>
        </TabsList>
      </Tabs>

      <div class="flex items-center gap-2 text-sm">
        <span v-if="admin" class="text-muted-foreground">{{ admin }}</span>

        <!-- Reload: kick a discovery/reconcile pass and refresh the lists. -->
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Reload"
          :disabled="reconcile.isPending.value"
          @click="reconcile.mutate()"
        >
          <RefreshCw :class="reconcile.isPending.value ? 'animate-spin' : ''" />
        </Button>

        <!-- Bell wears an overlay dot when any alert is live; the list opens in a menu. -->
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon-sm" class="relative" aria-label="Notifications">
              <Bell />
              <span
                v-if="hasAny"
                data-slot="notification-dot"
                class="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-secondary ring-2 ring-background"
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-lg max-w-[calc(100vw-2rem)] p-0">
            <div class="flex items-center justify-between border-b px-3 py-2">
              <p class="text-sm font-medium">Notifications</p>
              <span class="text-xs text-muted-foreground">{{ all.length }}</span>
            </div>
            <div class="space-y-2 p-3">
              <!-- Global health (`system:*`): `detail` is the error; serving is degraded until
                   fixed. Rendered above the resource list, distinct from it. -->
              <p
                v-for="s in systemAlerts"
                :key="`${s.scope}:${s.kind}`"
                class="text-sm text-destructive"
              >
                ⚠ {{ systemCopy(s).title }}: {{ s.detail
                }}<template v-if="systemCopy(s).note"> — {{ systemCopy(s).note }}.</template>
              </p>
              <AlertsPanel v-if="list.length" :alerts="list" />
              <p v-if="!all.length" class="text-sm text-muted-foreground">No notifications.</p>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  </header>
</template>
