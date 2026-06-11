<script setup lang="ts">
import {
  STORAGE_ACTIONS,
  STORAGE_STATES,
  canPurge,
  lifecycleState,
  purgeRequires,
  type StorageAction,
} from '@worker/storage/actions';
import { MoreHorizontal } from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';

import StatusBadge from '@/components/StatusBadge.vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import type { StorageRow } from '@/composables/useStorage';
import { useStorageMutations } from '@/composables/useStorageMutations';
import { formatSize, formatTime, formatRelative, formatUntil } from '@/lib/format';

const props = defineProps<{ storage: StorageRow[]; highlight?: string }>();

const { archive, restore, purge, confirmWorkflow, cancelWorkflow } = useStorageMutations();

// Deep-link target from a notification (`?highlight=lc(owner/repo)`): ring the matching row
// and scroll it into view. The prefix may be cased; match case-insensitively.
const highlightKey = computed(() => props.highlight?.toLowerCase() ?? null);
const isHighlighted = (r: StorageRow) =>
  highlightKey.value !== null && r.prefix.toLowerCase() === highlightKey.value;
let highlightedRow: HTMLElement | null = null;
const captureHighlight = (r: StorageRow) => (el: unknown) => {
  if (el && isHighlighted(r)) highlightedRow = (el as { $el: HTMLElement }).$el;
};
onMounted(() => highlightedRow?.scrollIntoView({ behavior: 'smooth', block: 'center' }));

// "Stored" = objects present in storage plus pending writes; excludes missing/deleted/purged.
const storedCount = (r: StorageRow) => r.usage.present.count + r.usage.pending.count;
const storedSize = (r: StorageRow) => r.usage.present.size + r.usage.pending.size;

// Per-status object rows for the Size hover, in lifecycle order, zero rows dropped.
const OBJECT_STATUSES = ['present', 'pending', 'missing', 'deleted', 'purged'] as const;
const objectBreakdown = (r: StorageRow) =>
  OBJECT_STATUSES.map((s) => ({ status: s, ...r.usage[s] })).filter((o) => o.count > 0);

// Inline confirm: clicking Archive/Restore/Purge swaps the action buttons in place for a
// {confirm} | Cancel pair with the action's description right underneath. One row confirms at a time.
const confirmFor = ref<{ prefix: string; action: StorageAction } | null>(null);
const startConfirm = (r: StorageRow, action: StorageAction) =>
  (confirmFor.value = { prefix: r.prefix, action });

const confirm = (
  mutation: { mutate: (v: { owner: string; repo: string }) => void },
  r: StorageRow,
) => mutation.mutate({ owner: r.owner, repo: r.repo });

// Run the confirmed mutation, then drop back to the default buttons.
const runConfirm = (r: StorageRow) => {
  confirm({ archive, restore, purge }[confirmFor.value!.action], r);
  confirmFor.value = null;
};
</script>

<template>
  <ItemGroup data-slot="storage-list" class="gap-2">
    <template v-for="r in storage" :key="r.prefix">
      <Item
        variant="outline"
        class="items-start"
        :ref="captureHighlight(r)"
        :class="isHighlighted(r) ? 'animate-highlight' : ''"
      >
        <ItemContent>
          <!-- Row 1: prefix + the storage's used/unused state badge, vertically centered. -->
          <div class="flex items-center justify-between gap-4">
            <ItemTitle class="font-mono break-all">{{ r.prefix }}</ItemTitle>

            <!-- State badge: the storage's used/unused state. `used` names the repo it serves. -->
            <div data-slot="status" class="shrink-0">
              <HoverCard v-if="r.status === 'used'">
                <HoverCardTrigger as-child>
                  <StatusBadge status="used" class="h-6" />
                </HoverCardTrigger>
                <HoverCardContent side="left" class="w-auto">
                  <p class="font-medium">Used</p>
                  <p class="text-muted-foreground">
                    Actively serving Git LFS<template v-if="r.gitRepo">
                      for
                      <RouterLink to="/repos" class="font-mono"
                        >{{ r.gitRepo.owner }}/{{ r.gitRepo.repo }}</RouterLink
                      ></template
                    >
                    — nothing scheduled to archive.
                  </p>
                </HoverCardContent>
              </HoverCard>

              <HoverCard v-else-if="r.status === 'purged'">
                <HoverCardTrigger as-child>
                  <StatusBadge status="purged" class="h-6" />
                </HoverCardTrigger>
                <HoverCardContent side="left" class="w-auto">
                  <p class="font-medium">
                    Purged <template v-if="r.purgedAt">{{ formatRelative(r.purgedAt) }}</template>
                  </p>
                  <p class="text-muted-foreground whitespace-pre-line">
                    <template v-if="r.purgedAt">{{ formatTime(r.purgedAt) }} — </template
                    >{{ STORAGE_STATES.purged.description }}
                  </p>
                </HoverCardContent>
              </HoverCard>

              <HoverCard v-else-if="r.archivedAt">
                <HoverCardTrigger as-child>
                  <Badge variant="secondary" class="h-6">archived</Badge>
                </HoverCardTrigger>
                <HoverCardContent side="left" class="w-auto">
                  <p class="font-medium">Archived {{ formatRelative(r.archivedAt) }}</p>
                  <p class="text-muted-foreground whitespace-pre-line">
                    {{ formatTime(r.archivedAt) }} — {{ STORAGE_STATES.archived.description }}
                  </p>
                </HoverCardContent>
              </HoverCard>

              <HoverCard v-else>
                <HoverCardTrigger as-child>
                  <StatusBadge status="unused" class="h-6" />
                </HoverCardTrigger>
                <HoverCardContent side="left" class="w-auto">
                  <p class="font-medium">Unused</p>
                  <p class="text-muted-foreground whitespace-pre-line">
                    {{ STORAGE_STATES.unused.description }}
                  </p>
                </HoverCardContent>
              </HoverCard>
            </div>
          </div>

          <!-- Row 2: metrics + lifecycle actions, top-aligned so the metrics line sits on the same
               row as the action buttons and an expanding confirm grows downward (title stays put).
               Dropped entirely once purged — every object is gone, so size/last-accessed are moot
               and there are no actions; the row1 badge stands alone (keeps padding symmetric). -->
          <div v-if="r.status !== 'purged'" class="flex items-start justify-between gap-4">
            <!-- Metrics: stored size (hover → per-status object breakdown), last accessed, and — for
                 an unused prefix awaiting auto-archive — the relative archive deadline. Each
                 label+value is a nowrap group so only the "·" dividers wrap, never a label from its
                 value. -->
            <ItemDescription
              data-slot="metrics"
              class="flex flex-wrap items-center gap-x-2 gap-y-1"
            >
              <span class="inline-flex items-center gap-1.5 whitespace-nowrap">
                <span>Size</span>
                <HoverCard>
                  <HoverCardTrigger as-child>
                    <span class="cursor-default text-foreground">{{
                      formatSize(storedSize(r))
                    }}</span>
                  </HoverCardTrigger>
                  <HoverCardContent class="w-auto">
                    <p class="font-medium">{{ storedCount(r) }} objects</p>
                    <table class="mt-1 text-muted-foreground">
                      <tr v-for="o in objectBreakdown(r)" :key="o.status">
                        <td class="pr-4">{{ o.status }}</td>
                        <td class="pr-4 text-right tabular-nums">{{ o.count }}</td>
                        <td class="text-right tabular-nums">{{ formatSize(o.size) }}</td>
                      </tr>
                    </table>
                  </HoverCardContent>
                </HoverCard>
              </span>

              <span class="text-muted-foreground/50">·</span>

              <span class="inline-flex items-center gap-1.5 whitespace-nowrap">
                <span>Last accessed</span>
                <HoverCard v-if="r.lastAccessedAt">
                  <HoverCardTrigger as-child>
                    <span class="text-foreground">{{ formatRelative(r.lastAccessedAt) }}</span>
                  </HoverCardTrigger>
                  <HoverCardContent class="w-auto">
                    <p class="font-medium">Last served {{ formatTime(r.lastAccessedAt) }}</p>
                    <p class="text-muted-foreground">
                      Most recent time this storage served a Git LFS object.
                    </p>
                  </HoverCardContent>
                </HoverCard>
                <span v-else class="text-foreground">—</span>
              </span>

              <!-- Auto-archive deadline for an unused, not-yet-archived prefix: relative ("in 3 d"),
                 full timestamp on hover. -->
              <template v-if="r.status === 'unused' && !r.archivedAt && r.willArchiveAt">
                <span class="text-muted-foreground/50">·</span>
                <span
                  data-slot="archiving"
                  class="inline-flex items-center gap-1.5 whitespace-nowrap"
                >
                  <span>Archiving in</span>
                  <HoverCard>
                    <HoverCardTrigger as-child>
                      <span class="text-foreground">{{ formatUntil(r.willArchiveAt) }}</span>
                    </HoverCardTrigger>
                    <HoverCardContent class="w-auto">
                      <p class="font-medium">Auto-archives {{ formatTime(r.willArchiveAt) }}</p>
                      <p class="text-muted-foreground">
                        The repo is missing, so this storage is unused and will be archived
                        automatically.
                      </p>
                    </HoverCardContent>
                  </HoverCard>
                </span>
              </template>
            </ItemDescription>

            <!-- Lifecycle actions: top-aligned with the metrics line so they share a row; an
                 expanding inline confirm grows downward. -->
            <div data-slot="lifecycle" class="flex shrink-0 flex-col items-end gap-2">
              <!-- A Purge workflow is in flight, waiting for confirmation: show the countdown to the
                   auto-proceed deadline plus inline Confirm (delete now) / Cancel (abort). -->
              <div
                v-if="r.activeOp === 'purge'"
                data-slot="actions"
                class="inline-flex items-center justify-end gap-2"
              >
                <HoverCard>
                  <HoverCardTrigger as-child>
                    <Badge variant="secondary" class="h-6"
                      >purging<template v-if="r.purgeConfirmBy">
                        · {{ formatUntil(r.purgeConfirmBy) }}</template
                      ></Badge
                    >
                  </HoverCardTrigger>
                  <HoverCardContent side="top">
                    <p class="font-medium">Purge pending</p>
                    <p class="text-muted-foreground">
                      <template v-if="r.purgeConfirmBy"
                        >Deletes automatically {{ formatTime(r.purgeConfirmBy) }} unless cancelled. </template
                      >Confirm to delete every file now, or Cancel to abort.
                    </p>
                  </HoverCardContent>
                </HoverCard>
                <Button
                  size="xs"
                  variant="destructive"
                  :disabled="confirmWorkflow.isPending.value"
                  @click="confirm(confirmWorkflow, r)"
                  >Purge now</Button
                >
                <Button
                  size="xs"
                  variant="ghost"
                  :disabled="cancelWorkflow.isPending.value"
                  @click="confirm(cancelWorkflow, r)"
                  >Cancel</Button
                >
              </div>

              <!-- Unused: archived rows offer Restore, not-yet-archived rows offer Archive. Purge is the
               destructive overflow — enabled only once archived. Clicking an action swaps these
               buttons in place for an inline {confirm} | Cancel pair with the description underneath. -->
              <div
                v-else-if="r.status === 'unused'"
                data-slot="actions"
                class="flex flex-col items-end gap-2"
              >
                <!-- Confirming: inline confirm replaces the action buttons. -->
                <template v-if="confirmFor && confirmFor.prefix === r.prefix">
                  <div data-slot="confirm" class="flex items-center gap-2">
                    <!-- Purge needs an archived prefix; otherwise the confirm is blocked (Archive first). -->
                    <Button
                      v-if="confirmFor.action === 'purge' && !canPurge(lifecycleState(r))"
                      size="xs"
                      variant="destructive"
                      disabled
                      >{{ STORAGE_ACTIONS.purge.label }}</Button
                    >
                    <Button
                      v-else
                      size="xs"
                      :variant="confirmFor.action === 'restore' ? 'outline' : 'destructive'"
                      :disabled="
                        archive.isPending.value || restore.isPending.value || purge.isPending.value
                      "
                      @click="runConfirm(r)"
                      >{{ STORAGE_ACTIONS[confirmFor.action].label }}</Button
                    >
                    <Button size="xs" variant="ghost" @click="confirmFor = null">Cancel</Button>
                  </div>
                </template>

                <!-- Default: the action ButtonGroup (archived state shows in the row-1 status badge). -->
                <ButtonGroup v-else>
                  <!-- Primary: Restore (archived) or Archive (not yet). -->
                  <Button
                    size="xs"
                    variant="outline"
                    @click="startConfirm(r, STORAGE_STATES[lifecycleState(r)].action!)"
                    >{{ STORAGE_ACTIONS[STORAGE_STATES[lifecycleState(r)].action!].label }}</Button
                  >
                  <!-- "…" overflow: Purge. -->
                  <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                      <Button size="icon-xs" variant="outline" aria-label="More actions">
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem variant="destructive" @select="startConfirm(r, 'purge')">
                        {{ STORAGE_ACTIONS.purge.label }}…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </ButtonGroup>
              </div>
            </div>
          </div>

          <!-- Row 3: the confirm action's description — a full-bleed footer band that splits the
               item by background (negative margins reach the item's padded edges, top border +
               muted fill, bottom corners rounded to match). Never squeezes the metrics row. -->
          <p
            v-if="confirmFor && confirmFor.prefix === r.prefix"
            data-slot="confirm-description"
            class="-mx-4 -mb-4 mt-2 rounded-b-md border-t bg-muted/50 px-4 py-2 text-sm whitespace-pre-line text-muted-foreground"
          >
            {{ STORAGE_ACTIONS[confirmFor.action].consequence
            }}<template v-if="confirmFor.action === 'purge' && !r.archivedAt">
              Archive this storage first.</template
            >
          </p>
        </ItemContent>
      </Item>
    </template>
  </ItemGroup>
</template>
