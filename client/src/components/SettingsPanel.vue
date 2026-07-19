<script setup lang="ts">
import { computed, ref } from 'vue'
import type { IniSummary } from '../types'

const props = defineProps<{
  api: Record<string, unknown> | null
  ini: IniSummary | null
}>()

const open = ref(false)

const rows = computed(() => {
  const out: { key: string; value: string; source: string }[] = []
  if (props.ini?.fields) {
    for (const [key, value] of Object.entries(props.ini.fields)) {
      out.push({ key, value: String(value), source: 'ini' })
    }
  }
  if (props.api && typeof props.api === 'object') {
    for (const [key, value] of Object.entries(props.api)) {
      if (value == null || typeof value === 'object') continue
      if (/password/i.test(key)) continue
      out.push({ key, value: String(value), source: 'api' })
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key))
})
</script>

<template>
  <UCard>
    <template #header>
      <button
        type="button"
        class="flex w-full items-center justify-between gap-2 text-left"
        @click="open = !open"
      >
        <div>
          <h2 class="text-base font-semibold">Settings snapshot</h2>
          <p class="text-xs text-muted">Read-only view from API + PalWorldSettings.ini</p>
        </div>
        <UIcon :name="open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-5 text-muted" />
      </button>
    </template>

    <div v-show="open">
      <div v-if="rows.length === 0" class="py-6 text-center text-sm text-muted">
        No settings loaded yet
      </div>
      <div v-else class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <div
          v-for="row in rows"
          :key="`${row.source}-${row.key}`"
          class="rounded-lg border border-default bg-default/40 px-3 py-2"
        >
          <div class="flex items-center justify-between gap-2">
            <p class="truncate text-xs font-medium text-muted">{{ row.key }}</p>
            <UBadge size="sm" color="neutral" variant="subtle">{{ row.source }}</UBadge>
          </div>
          <p class="mt-1 truncate text-sm">{{ row.value }}</p>
        </div>
      </div>
    </div>
  </UCard>
</template>
