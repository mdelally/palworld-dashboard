<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { AutostopState } from '../types'

const props = defineProps<{
  state: AutostopState | null
  busy: boolean
}>()

const emit = defineEmits<{
  update: [patch: { enabled?: boolean; delayMinutes?: number }]
  cancel: []
}>()

const localEnabled = ref(false)
const localDelay = ref(60)

watch(
  () => props.state,
  (s) => {
    if (!s) return
    localEnabled.value = s.enabled
    localDelay.value = s.delayMinutes
  },
  { immediate: true },
)

const delayOptions = computed(() => {
  const allowed = props.state?.allowedDelayMinutes?.length
    ? props.state.allowedDelayMinutes
    : [30, 45, 60, 120]
  return allowed.map((m) => ({
    label: m < 60 ? `${m} min` : m === 60 ? '1 hour' : `${m / 60} hours`,
    value: m,
  }))
})

// Client-side countdown that ticks every second from the last SSE remainingMs /
// deadlineAt so the UI doesn't wait for the next poll.
const now = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null
watch(
  () => props.state?.deadlineAt,
  (deadline) => {
    if (tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }
    if (deadline != null) {
      now.value = Date.now()
      tickTimer = setInterval(() => {
        now.value = Date.now()
      }, 1000)
    }
  },
  { immediate: true },
)
onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
})

const remainingLabel = computed(() => {
  const s = props.state
  if (!s?.armed || s.deadlineAt == null) return null
  const ms = Math.max(0, s.deadlineAt - now.value)
  const totalSec = Math.ceil(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${m}:${String(sec).padStart(2, '0')}`
})

function onToggle(value: boolean) {
  localEnabled.value = value
  emit('update', { enabled: value })
}

function onDelayChange(value: number | string) {
  const n = Number(value)
  localDelay.value = n
  emit('update', { delayMinutes: n })
}
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-start justify-between gap-3">
        <div>
          <h2 class="text-base font-semibold">Autostop</h2>
          <p class="text-xs text-muted">
            When the last player leaves, save and stop the container after a delay
          </p>
        </div>
        <UBadge
          v-if="state?.stopping"
          color="warning"
          variant="subtle"
        >
          Stopping…
        </UBadge>
        <UBadge
          v-else-if="state?.armed"
          color="warning"
          variant="solid"
        >
          Armed {{ remainingLabel }}
        </UBadge>
        <UBadge
          v-else-if="state?.enabled"
          color="success"
          variant="subtle"
        >
          Armed when empty
        </UBadge>
        <UBadge
          v-else
          color="neutral"
          variant="subtle"
        >
          Off
        </UBadge>
      </div>
    </template>

    <div class="flex flex-col gap-4">
      <div class="flex items-center justify-between gap-3">
        <div>
          <p class="text-sm font-medium">Enable autostop</p>
          <p class="text-xs text-muted">
            Only starts after a real last-player logout, not on dashboard boot
          </p>
        </div>
        <USwitch
          :model-value="localEnabled"
          :disabled="busy"
          @update:model-value="onToggle"
        />
      </div>

      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p class="text-sm font-medium">Idle delay</p>
        <USelect
          :model-value="localDelay"
          :items="delayOptions"
          value-key="value"
          class="w-40"
          :disabled="busy || !localEnabled"
          @update:model-value="onDelayChange"
        />
      </div>

      <div
        v-if="state?.armed"
        class="flex items-center justify-between gap-3 border-t border-default pt-4"
      >
        <p class="text-xs text-muted">
          World is empty. Container stops in
          <span class="font-mono font-semibold text-highlighted">{{ remainingLabel }}</span>
          unless someone joins.
        </p>
        <UButton
          color="neutral"
          variant="soft"
          icon="i-lucide-timer-off"
          :disabled="busy"
          @click="emit('cancel')"
        >
          Cancel
        </UButton>
      </div>
    </div>
  </UCard>
</template>
