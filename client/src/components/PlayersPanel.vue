<script setup lang="ts">
import { computed } from 'vue'
import type { Player } from '../types'

const props = defineProps<{
  players: Player[]
}>()

const rows = computed(() =>
  props.players.map((p, i) => ({
    id: String(p.userId || p.userid || p.playerId || p.playerid || i),
    name: p.name || 'Unknown',
    level: p.level ?? '—',
    ping: typeof p.ping === 'number' ? Math.round(p.ping) : '—',
    location:
      p.location_x != null && p.location_y != null
        ? `${Math.round(Number(p.location_x))}, ${Math.round(Number(p.location_y))}`
        : '—',
  })),
)

const columns = [
  { accessorKey: 'name', header: 'Player' },
  { accessorKey: 'level', header: 'Level' },
  { accessorKey: 'ping', header: 'Ping' },
  { accessorKey: 'location', header: 'Location' },
]
</script>

<template>
  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <div class="flex items-center justify-between gap-2">
        <div>
          <h2 class="text-base font-semibold">Online players</h2>
          <p class="text-xs text-muted">Live roster from the REST API</p>
        </div>
        <UBadge color="neutral" variant="subtle">{{ rows.length }}</UBadge>
      </div>
    </template>

    <div v-if="rows.length === 0" class="px-4 py-10 text-center text-sm text-muted">
      No players online
    </div>
    <UTable v-else :data="rows" :columns="columns" class="shrink-0" />
  </UCard>
</template>
