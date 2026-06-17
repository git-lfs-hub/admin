<script setup lang="ts">
import {
  STORAGE_ACTIONS,
  STORAGE_STATES,
  canPurge,
  lifecycleState,
  type StorageAction,
} from '@worker/storage/actions';
import { MoreHorizontal } from 'lucide-vue-next';
import { computed, onMounted, ref, watch } from 'vue';
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

const props = defineProps<{ storage: StorageRow[]; highlight?: string; coldStorage?: boolean }>();

const { archive, restore, purge, backup, deleteBackup, clear, confirmWorkflow, cancelWorkflow } =
  useStorageMutations();

// In-flight cold-storage ops (purge keeps its own countdown UI below) — a plain progress badge.
const OP_LABELS: Record<string, string> = {
  backup: 'backing up',
  clear: 'clearing',
  deleteBackup: 'deleting backup',
  restore: 'restoring',
};

// Deep-link target from a notification (`?highlight=lc(owner/repo)`): ring the matching row and
// scroll it into view. Prefix may be cased, so match case-insensitively.
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

// Inline confirm: clicking an action swaps the buttons for a {confirm} | Cancel pair with its
// description underneath. One row confirms at a time.
const confirmFor = ref<{ prefix: string; action: StorageAction } | null>(null);
const startConfirm = (r: StorageRow, action: StorageAction) =>
  (confirmFor.value = { prefix: r.prefix, action });

// Freeze row order while a confirm is open so a background poll's re-sort can't shuffle rows out
// from under the confirm you're reading. Rows still update in place; only their order is pinned.
const frozenOrder = ref<string[] | null>(null);
watch(confirmFor, (c) => (frozenOrder.value = c ? props.storage.map((r) => r.prefix) : null));
const rows = computed(() => {
  if (!frozenOrder.value) return props.storage;
  const order = new Map(frozenOrder.value.map((p, i) => [p, i]));
  // New rows (absent from the snapshot) sink to the bottom in their incoming order.
  return [...props.storage].sort(
    (a, b) => (order.get(a.prefix) ?? Infinity) - (order.get(b.prefix) ?? Infinity),
  );
});

const confirm = (
  mutation: { mutate: (v: { owner: string; repo: string }) => void },
  r: StorageRow,
) => mutation.mutate({ owner: r.owner, repo: r.repo });

const runConfirm = (r: StorageRow) => {
  confirm({ archive, restore, purge, backup, deleteBackup, clear }[confirmFor.value!.action], r);
  confirmFor.value = null;
};
</script>

<template>
  <ItemGroup data-slot="storage-list" class="gap-2">
    <template v-for="r in rows" :key="r.prefix">
      <Item
        variant="outline"
        class="items-start"
        :ref="captureHighlight(r)"
        :class="isHighlighted(r) ? 'animate-highlight' : ''"
      >
        <ItemContent>
          <div class="flex items-center justify-between gap-4">
            <ItemTitle class="font-mono break-all">{{ r.prefix }}</ItemTitle>

            <!-- `used` names the repo it serves. -->
            <div data-slot="status" class="shrink-0">
              <HoverCard v-if="r.status === 'used'">
                <HoverCardTrigger as-child>
                  <StatusBadge status="used" class="h-6" />
                </HoverCardTrigger>
                <HoverCardContent side="left" class="w-auto">
                  <p class="font-medium">Used</p>
                  <p class="text-muted-foreground">
                    Actively serving Git LFS<template v-if="r.gitRepos.length">
                      for
                      <template v-for="(g, i) in r.gitRepos" :key="`${g.owner}/${g.repo}`"
                        ><template v-if="i > 0">, </template
                        ><RouterLink to="/repos" class="font-mono"
                          >{{ g.owner }}/{{ g.repo }}</RouterLink
                        ></template
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

          <!-- Dropped once purged — every object is gone, so metrics/actions are moot and the row-1
               badge stands alone. -->
          <div v-if="r.status !== 'purged'" class="flex items-start justify-between gap-4">
            <!-- Each label+value is a nowrap group so only the "·" dividers wrap, never a label from
                 its value. -->
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

              <!-- Auto-archive deadline for an unused, not-yet-archived prefix. -->
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

              <!-- Backup state — only when a cold-storage backend is configured and a cold copy exists. -->
              <template v-if="coldStorage && r.backedUpAt">
                <span class="text-muted-foreground/50">·</span>
                <span data-slot="backup" class="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <span>Backup</span>
                  <HoverCard>
                    <HoverCardTrigger as-child>
                      <span class="text-foreground">{{
                        r.clearedAt ? 'live cleared' : formatRelative(r.backedUpAt)
                      }}</span>
                    </HoverCardTrigger>
                    <HoverCardContent class="w-auto">
                      <p class="font-medium">
                        {{ r.backupComplete ? 'Backed up' : 'Backup incomplete' }}
                        {{ formatTime(r.backedUpAt) }}
                      </p>
                      <p class="text-muted-foreground">
                        {{
                          r.clearedAt
                            ? 'Live copy cleared — cold storage holds the only copy.'
                            : r.backupComplete
                              ? 'A complete cold copy exists.'
                              : 'A partial cold copy exists; back up again to complete it.'
                        }}
                      </p>
                    </HoverCardContent>
                  </HoverCard>
                </span>
              </template>
            </ItemDescription>

            <div data-slot="lifecycle" class="flex shrink-0 flex-col items-end gap-2">
              <!-- Purge workflow in flight: countdown to the auto-proceed deadline plus inline
                   Confirm (delete now) / Cancel (abort). -->
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

              <!-- Any other in-flight op (backup/clear/delete-backup/restore): a progress badge.
                   Suppresses the action buttons so a second op can't be started under it. -->
              <div
                v-else-if="r.activeOp"
                data-slot="actions"
                class="inline-flex items-center justify-end"
              >
                <Badge variant="secondary" class="h-6">{{
                  OP_LABELS[r.activeOp] ?? r.activeOp
                }}</Badge>
              </div>

              <!-- Unused-archived offers Restore, not-yet-archived offers Archive; used (live) offers
                   no primary action, only Back Up via the "…" overflow — so the block renders for a
                   used row only when cold storage is on (else nothing to show). Purge is the
                   destructive overflow, never offered for a live (used) prefix. -->
              <div
                v-else-if="coldStorage || lifecycleState(r) !== 'used'"
                data-slot="actions"
                class="flex flex-col items-end gap-2"
              >
                <template v-if="confirmFor && confirmFor.prefix === r.prefix">
                  <div data-slot="confirm" class="flex items-center gap-2">
                    <Button
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
                  <!-- Primary: Restore (archived) or Archive (not yet). Used has no default action. -->
                  <Button
                    v-if="STORAGE_STATES[lifecycleState(r)].action"
                    size="xs"
                    variant="outline"
                    @click="startConfirm(r, STORAGE_STATES[lifecycleState(r)].action!)"
                    >{{ STORAGE_ACTIONS[STORAGE_STATES[lifecycleState(r)].action!].label }}</Button
                  >
                  <!-- "…" overflow: cold-storage actions + Purge (never for a live `used` prefix). -->
                  <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                      <Button size="icon-xs" variant="outline" aria-label="More actions">
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <!-- Cold-storage backup management — only when a backend is configured. -->
                      <template v-if="coldStorage">
                        <DropdownMenuItem v-if="!r.clearedAt" @select="confirm(backup, r)">
                          {{ STORAGE_ACTIONS.backup.label }}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          v-if="r.archivedAt && r.backupComplete && !r.clearedAt"
                          @select="startConfirm(r, 'clear')"
                        >
                          {{ STORAGE_ACTIONS.clear.label }}…
                        </DropdownMenuItem>
                        <!-- Hidden once cleared: the cold copy is then the only copy. -->
                        <DropdownMenuItem
                          v-if="r.backedUpAt && !r.clearedAt"
                          @select="startConfirm(r, 'deleteBackup')"
                        >
                          {{ STORAGE_ACTIONS.deleteBackup.label }}…
                        </DropdownMenuItem>
                      </template>
                      <DropdownMenuItem
                        v-if="canPurge(lifecycleState(r))"
                        variant="destructive"
                        @select="startConfirm(r, 'purge')"
                      >
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
            {{ STORAGE_ACTIONS[confirmFor.action].consequence }}
          </p>
        </ItemContent>
      </Item>
    </template>
  </ItemGroup>
</template>
