<script setup lang="ts">
import type { BanEntry } from '../types'

const props = defineProps<{
  bans: BanEntry[]
  busy?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  unban: [userid: string, name: string]
}>()

function fmtTime(ts: number) {
  return new Date(ts).toLocaleString()
}

function requestUnban(entry: BanEntry) {
  if (props.busy || props.disabled) return
  emit('unban', entry.userid, entry.name || entry.userid)
}
</script>

<template>
  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <div class="flex items-center justify-between gap-2">
        <div>
          <h2 class="text-base font-semibold">Banned players</h2>
          <p class="text-xs text-muted">Local record — unban to allow rejoining</p>
        </div>
        <UBadge color="neutral" variant="subtle">{{ bans.length }}</UBadge>
      </div>
    </template>

    <div v-if="bans.length === 0" class="px-4 py-10 text-center text-sm text-muted">
      No bans on record
    </div>
    <ul v-else class="divide-y divide-default">
      <li
        v-for="ban in bans"
        :key="ban.userid"
        class="flex items-center justify-between gap-3 px-4 py-3"
      >
        <div class="min-w-0">
          <p class="truncate text-sm font-medium">{{ ban.name || 'Unknown' }}</p>
          <p class="truncate text-xs text-muted break-all">{{ ban.userid }}</p>
          <p v-if="ban.reason" class="truncate text-xs text-muted">“{{ ban.reason }}”</p>
          <p class="text-xs text-muted">{{ fmtTime(ban.ts) }}</p>
        </div>
        <UButton
          size="xs"
          color="neutral"
          variant="soft"
          icon="i-lucide-user-check"
          :disabled="busy || disabled"
          @click="requestUnban(ban)"
        >
          Unban
        </UButton>
      </li>
    </ul>
  </UCard>
</template>
