<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { LogEntry } from '../types'

const props = defineProps<{
  logs: LogEntry[]
  paused: boolean
}>()

defineEmits<{
  pause: []
  resume: []
  clear: []
}>()

const scroller = ref<HTMLElement | null>(null)
const autoScroll = ref(true)

function levelClass(line: string) {
  const l = line.toLowerCase()
  if (l.includes('error') || l.includes('fatal')) return 'text-error'
  if (l.includes('warn')) return 'text-warning'
  if (l.includes('joined') || l.includes('login')) return 'text-success'
  return 'text-muted'
}

watch(
  () => props.logs.length,
  async () => {
    if (!autoScroll.value || props.paused) return
    await nextTick()
    if (scroller.value) {
      scroller.value.scrollTop = scroller.value.scrollHeight
    }
  },
)
</script>

<template>
  <UCard class="flex min-h-[28rem] flex-1 flex-col" :ui="{ body: 'flex flex-1 flex-col p-0 sm:p-0' }">
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-base font-semibold">Live log</h2>
          <p class="text-xs text-muted">Tailing mounted server logs</p>
        </div>
        <div class="flex items-center gap-1">
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            :icon="paused ? 'i-lucide-play' : 'i-lucide-pause'"
            @click="paused ? $emit('resume') : $emit('pause')"
          >
            {{ paused ? 'Resume' : 'Pause' }}
          </UButton>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-trash-2"
            @click="$emit('clear')"
          >
            Clear
          </UButton>
        </div>
      </div>
    </template>

    <div
      ref="scroller"
      class="log-feed max-h-[32rem] flex-1 overflow-auto px-3 py-3 text-xs leading-5"
      @scroll="
        (e) => {
          const el = e.target as HTMLElement
          autoScroll = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }
      "
    >
      <div v-if="logs.length === 0" class="py-8 text-center text-muted">
        Waiting for log lines…
      </div>
      <div
        v-for="(entry, i) in logs"
        :key="`${entry.ts}-${i}`"
        class="whitespace-pre-wrap break-all"
        :class="levelClass(entry.line)"
      >
        {{ entry.line }}
      </div>
    </div>
  </UCard>
</template>
