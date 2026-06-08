<script setup lang="ts">
import { RouterLink } from 'vue-router';

import StatusBadge from '@/components/StatusBadge.vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { StorageRow } from '@/composables/useStorage';
import { useStorageMutations } from '@/composables/useStorageMutations';
import { formatSize, formatTime, formatDate, formatRelative } from '@/lib/format';

defineProps<{ storage: StorageRow[] }>();

const { archive, restore } = useStorageMutations();

// "Stored" = objects present in storage plus pending writes; excludes missing/deleted/purged.
const storedCount = (r: StorageRow) => r.usage.present.count + r.usage.pending.count;
const storedSize = (r: StorageRow) => r.usage.present.size + r.usage.pending.size;

// Per-status object rows for the Size hover, in lifecycle order, zero rows dropped.
const OBJECT_STATUSES = ['present', 'pending', 'missing', 'deleted', 'purged'] as const;
const objectBreakdown = (r: StorageRow) =>
  OBJECT_STATUSES.map((s) => ({ status: s, ...r.usage[s] })).filter((o) => o.count > 0);

// The trigger button is absolutely overlaid (right-aligned, opaque) on top of the state text, so
// revealing it on hover / keeping it on open never changes the cell's flow width — no layout jump.
// Its right edge matches the text's, so the right-aligned popover (and its Cancel) line up with it.
const triggerOverlay =
  'absolute inset-y-0 right-0 hidden min-w-full items-center justify-center bg-background group-hover:inline-flex data-[state=open]:inline-flex';
// Confirm popover: box is centered over the trigger (align="center"), matching the hover-card. The
// buttons row (top) is right-padded by half the box minus half the trigger width, so Cancel's right
// edge lands on the trigger's right edge; -24 side-offset overlays the buttons onto the trigger.
const POPOVER = 'w-72 overflow-hidden p-0';

const confirm = (mutation: typeof archive, r: StorageRow) =>
  mutation.mutate({ owner: r.owner, repo: r.repo });
</script>

<template>
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Storage</TableHead>
        <TableHead>Repo</TableHead>
        <TableHead class="text-right">Size</TableHead>
        <TableHead class="text-center">Last accessed</TableHead>
        <TableHead class="text-center">Archive</TableHead>
        <TableHead class="text-center">Purge</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow v-for="r in storage" :key="r.prefix">
        <TableCell class="font-mono whitespace-normal break-all">{{ r.prefix }}</TableCell>

        <!-- Repo identity + the repo's GitHub presence. `active` is the norm (plain link); only the
             notable `missing` is badged. An orphan prefix (no tracked repo) is itself `missing`. -->
        <TableCell class="font-mono">
          <span v-if="r.gitRepo" class="inline-flex items-center gap-2">
            <RouterLink to="/repos" class="hover:underline"
              >{{ r.gitRepo.owner }}/{{ r.gitRepo.repo }}</RouterLink
            >
            <HoverCard v-if="r.gitRepo.status === 'missing'">
              <HoverCardTrigger as-child>
                <StatusBadge status="missing" class="h-6" />
              </HoverCardTrigger>
              <HoverCardContent>
                <p class="font-medium">Repository missing</p>
                <p class="text-muted-foreground">
                  No longer found on GitHub. Its storage is now unused and will be archived
                  automatically.
                </p>
              </HoverCardContent>
            </HoverCard>
          </span>
          <HoverCard v-else>
            <HoverCardTrigger as-child>
              <StatusBadge status="missing" class="h-6" />
            </HoverCardTrigger>
            <HoverCardContent>
              <p class="font-medium">Repository missing</p>
              <p class="text-muted-foreground">
                No longer found on GitHub. Its storage is now unused and will be archived
                automatically.
              </p>
            </HoverCardContent>
          </HoverCard>
        </TableCell>

        <!-- Total stored size; hover breaks it down into objects by status. -->
        <TableCell class="text-right">
          <HoverCard>
            <HoverCardTrigger as-child>
              <span class="cursor-default">{{ formatSize(storedSize(r)) }}</span>
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
        </TableCell>

        <TableCell class="text-center">
          <HoverCard v-if="r.lastAccessedAt">
            <HoverCardTrigger as-child>
              <span>{{ formatRelative(r.lastAccessedAt) }}</span>
            </HoverCardTrigger>
            <HoverCardContent class="w-auto">
              <p class="font-medium">Last served {{ formatTime(r.lastAccessedAt) }}</p>
              <p class="text-muted-foreground">
                Most recent time this storage served a Git LFS object.
              </p>
            </HoverCardContent>
          </HoverCard>
          <template v-else>—</template>
        </TableCell>

        <!-- Archive column doubles as the Archive/Restore affordance: the badge/date shows the
             state, its hover explains it + the action, and hovering overlays the confirm trigger.
             Content is centered so the static `used`/`archived` badges share one column axis. -->
        <TableCell class="text-center">
          <!-- HoverCard is the OUTER wrapper so its anchor is the always-present span: the overlay
               trigger is display:none until hover, so anchoring the card to it makes the card jump
               to (0,0) the moment the pointer leaves the button. Popover is INNER, so its trigger
               resolves to the popover's own Popper and the confirm opens on-screen. -->
          <!-- Archived → "archived" badge; hover reveals Restore + the confirm popover. -->
          <HoverCard v-if="r.archivedAt">
            <HoverCardTrigger as-child>
              <span class="group relative inline-flex items-center">
                <Badge variant="secondary" class="h-6">archived</Badge>
                <Popover>
                  <PopoverTrigger as-child>
                    <Button size="xs" variant="outline" :class="triggerOverlay">Restore</Button>
                  </PopoverTrigger>
                  <PopoverContent
                    side="bottom"
                    align="center"
                    :side-offset="-24"
                    :avoid-collisions="false"
                    :class="POPOVER"
                  >
                    <div class="flex justify-end gap-2 pr-[calc(50%-34px)]">
                      <PopoverClose as-child>
                        <Button
                          size="xs"
                          variant="outline"
                          :disabled="restore.isPending.value"
                          @click="confirm(restore, r)"
                          >Restore</Button
                        >
                      </PopoverClose>
                      <PopoverClose as-child
                        ><Button size="xs" variant="ghost">Cancel</Button></PopoverClose
                      >
                    </div>
                    <div class="space-y-1 px-3 pb-3 pt-2">
                      <p class="text-sm font-medium">Restore</p>
                      <p class="text-sm text-muted-foreground">
                        Unarchives this storage so it serves Git LFS again.
                      </p>
                    </div>
                  </PopoverContent>
                </Popover>
              </span>
            </HoverCardTrigger>
            <HoverCardContent side="top" class="space-y-2">
              <div>
                <p class="font-medium">Archived {{ formatRelative(r.archivedAt) }}</p>
                <p class="text-muted-foreground">
                  {{ formatTime(r.archivedAt) }} — this storage no longer serves Git LFS. Files are
                  kept; nothing is deleted.
                </p>
              </div>
              <div>
                <p class="font-medium">Restore</p>
                <p class="text-muted-foreground">
                  Unarchives this storage so it serves Git LFS again.
                </p>
              </div>
            </HoverCardContent>
          </HoverCard>

          <!-- Unused (repo missing) → auto-archive deadline; hover reveals Archive. -->
          <HoverCard v-else-if="r.status === 'unused'">
            <HoverCardTrigger as-child>
              <span class="group relative inline-flex items-center">
                <span>{{ r.willArchiveAt ? formatDate(r.willArchiveAt) : '—' }}</span>
                <Popover>
                  <PopoverTrigger as-child>
                    <Button size="xs" variant="outline" :class="triggerOverlay">Archive</Button>
                  </PopoverTrigger>
                  <PopoverContent
                    side="bottom"
                    align="center"
                    :side-offset="-24"
                    :avoid-collisions="false"
                    :class="POPOVER"
                  >
                    <div class="flex justify-end gap-2 pr-[calc(50%-33px)]">
                      <PopoverClose as-child>
                        <Button
                          size="xs"
                          variant="destructive"
                          :disabled="archive.isPending.value"
                          @click="confirm(archive, r)"
                          >Archive</Button
                        >
                      </PopoverClose>
                      <PopoverClose as-child
                        ><Button size="xs" variant="ghost">Cancel</Button></PopoverClose
                      >
                    </div>
                    <div class="space-y-1 px-3 pb-3 pt-2">
                      <p class="text-sm font-medium">Archive now</p>
                      <p class="text-sm text-muted-foreground">
                        Stops this storage from serving Git LFS immediately. Files are kept; serving
                        resumes automatically if the repo reappears on GitHub.
                      </p>
                    </div>
                  </PopoverContent>
                </Popover>
              </span>
            </HoverCardTrigger>
            <HoverCardContent side="top" class="space-y-2">
              <div v-if="r.willArchiveAt">
                <p class="font-medium">Auto-archives {{ formatDate(r.willArchiveAt) }}</p>
                <p class="text-muted-foreground">
                  {{ formatTime(r.willArchiveAt) }} — the repo is missing, so this storage is unused
                  and will be archived automatically on this date.
                </p>
              </div>
              <div>
                <p class="font-medium">Archive now</p>
                <p class="text-muted-foreground">
                  Stops this storage from serving Git LFS immediately. Files are kept; serving
                  resumes automatically if the repo reappears on GitHub.
                </p>
              </div>
            </HoverCardContent>
          </HoverCard>

          <!-- Used (serving, nothing scheduled) → "used" badge; hover explains it. -->
          <HoverCard v-else-if="r.status === 'used'">
            <HoverCardTrigger as-child>
              <StatusBadge status="used" class="h-6" />
            </HoverCardTrigger>
            <HoverCardContent side="top" class="w-auto">
              <p class="font-medium">Used</p>
              <p class="text-muted-foreground">
                Actively serving Git LFS — nothing scheduled to archive.
              </p>
            </HoverCardContent>
          </HoverCard>

          <template v-else>—</template>
        </TableCell>

        <!-- Purge is the only storage action, so this column also carries the terminal `purged`
             state: a badge once purged, the Purge confirm otherwise. -->
        <TableCell class="text-center">
          <HoverCard v-if="r.status === 'purged'">
            <HoverCardTrigger as-child>
              <StatusBadge :status="r.status" class="h-6" />
            </HoverCardTrigger>
            <HoverCardContent side="top" class="w-auto">
              <p class="font-medium">
                Purged<template v-if="r.purgedAt"> {{ formatRelative(r.purgedAt) }}</template>
              </p>
              <p class="text-muted-foreground">
                <template v-if="r.purgedAt">{{ formatTime(r.purgedAt) }} — </template>every file in
                this storage was permanently deleted.
              </p>
            </HoverCardContent>
          </HoverCard>

          <HoverCard v-else>
            <HoverCardTrigger as-child>
              <span class="inline-flex">
                <Popover>
                  <PopoverTrigger as-child>
                    <Button size="xs" variant="destructive">Purge</Button>
                  </PopoverTrigger>
                  <PopoverContent
                    side="bottom"
                    align="center"
                    :side-offset="-24"
                    :avoid-collisions="false"
                    :class="POPOVER"
                  >
                    <div class="flex justify-end gap-2 pr-[calc(50%-26px)]">
                      <Button size="xs" variant="destructive" disabled>Purge</Button>
                      <PopoverClose as-child
                        ><Button size="xs" variant="ghost">Cancel</Button></PopoverClose
                      >
                    </div>
                    <div class="space-y-1 px-3 pb-3 pt-2">
                      <p class="text-sm font-medium">Purge</p>
                      <p class="text-sm text-muted-foreground">
                        Permanently deletes every file in this storage. Any repo using it loses
                        those files — including repos that still exist on GitHub. This can't be
                        undone. Not available yet.
                      </p>
                    </div>
                  </PopoverContent>
                </Popover>
              </span>
            </HoverCardTrigger>
            <HoverCardContent side="top">
              <p class="font-medium">Purge</p>
              <p class="text-muted-foreground">
                Permanently deletes every file in this storage. Any repo using it loses those files
                — including repos that still exist on GitHub. This can't be undone. Not available
                yet.
              </p>
            </HoverCardContent>
          </HoverCard>
        </TableCell>
      </TableRow>
    </TableBody>
  </Table>
</template>
