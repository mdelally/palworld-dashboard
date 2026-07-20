<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Player } from '../types'

const props = defineProps<{
  players: Player[]
  busy?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  kick: [userid: string, name: string]
  ban: [userid: string, name: string, reason: string]
}>()

interface Row {
  id: string
  userid: string
  name: string
  level: number | string
  ping: number | string
  location: string
}

const rows = computed<Row[]>(() =>
  props.players.map((p, i) => {
    const userid = String(p.userId || p.userid || '')
    return {
      id: userid || String(p.playerId || p.playerid || i),
      userid,
      name: p.name || 'Unknown',
      level: p.level ?? '—',
      ping: typeof p.ping === 'number' ? Math.round(p.ping) : '—',
      location:
        p.location_x != null && p.location_y != null
          ? `${Math.round(Number(p.location_x))}, ${Math.round(Number(p.location_y))}`
          : '—',
    }
  }),
)

const columns = [
  { accessorKey: 'name', header: 'Player' },
  { accessorKey: 'level', header: 'Level' },
  { accessorKey: 'ping', header: 'Ping' },
  { accessorKey: 'location', header: 'Location' },
  { accessorKey: 'actions', header: '' },
]

// Confirm modal state
const confirmOpen = ref(false)
const pending = ref<{ action: 'kick' | 'ban'; row: Row } | null>(null)
const banReason = ref('')

function requestKick(row: Row) {
  if (props.busy || props.disabled || !row.userid) return
  pending.value = { action: 'kick', row }
  banReason.value = ''
  confirmOpen.value = true
}

function requestBan(row: Row) {
  if (props.busy || props.disabled || !row.userid) return
  pending.value = { action: 'ban', row }
  banReason.value = ''
  confirmOpen.value = true
}

function confirmAction() {
  const p = pending.value
  confirmOpen.value = false
  if (!p) return
  if (p.action === 'kick') emit('kick', p.row.userid, p.row.name)
  else emit('ban', p.row.userid, p.row.name, banReason.value.trim())
  pending.value = null
}
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
    <UTable v-else :data="rows" :columns="columns" class="shrink-0">
      <template #actions-cell="{ row }">
        <div class="flex justify-end gap-1">
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-log-out"
            :disabled="busy || disabled || !row.original.userid"
            @click="requestKick(row.original)"
          >
            Kick
          </UButton>
          <UButton
            size="xs"
            color="error"
            variant="ghost"
            icon="i-lucide-ban"
            :disabled="busy || disabled || !row.original.userid"
            @click="requestBan(row.original)"
          >
            Ban
          </UButton>
        </div>
      </template>
    </UTable>

    <UModal
      v-model:open="confirmOpen"
      :title="pending?.action === 'ban' ? 'Ban player?' : 'Kick player?'"
    >
      <template #body>
        <div class="flex flex-col gap-3">
          <p class="text-sm text-muted">
            <template v-if="pending?.action === 'ban'">
              Ban <span class="font-medium text-highlighted">{{ pending?.row.name }}</span>?
              They'll be disconnected and blocked from rejoining, and added to the banlist.
            </template>
            <template v-else>
              Kick <span class="font-medium text-highlighted">{{ pending?.row.name }}</span>?
              They can reconnect immediately.
            </template>
          </p>
          <p class="text-xs text-muted break-all">ID: {{ pending?.row.userid }}</p>
          <UInput
            v-if="pending?.action === 'ban'"
            v-model="banReason"
            placeholder="Reason (optional)"
            maxlength="200"
          />
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="confirmOpen = false">
            Cancel
          </UButton>
          <UButton
            :color="pending?.action === 'ban' ? 'error' : 'warning'"
            :icon="pending?.action === 'ban' ? 'i-lucide-ban' : 'i-lucide-log-out'"
            @click="confirmAction"
          >
            {{ pending?.action === 'ban' ? 'Ban' : 'Kick' }}
          </UButton>
        </div>
      </template>
    </UModal>
  </UCard>
</template>
