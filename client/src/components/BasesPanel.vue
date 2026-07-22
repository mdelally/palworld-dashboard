<script setup lang="ts">
import { computed, ref } from 'vue'
import type { BaseCamp, BasesReport } from '../types'

const props = defineProps<{
  report: BasesReport | null
  busy?: boolean
}>()

const emit = defineEmits<{
  refresh: []
}>()

const expanded = ref<Record<string, boolean>>({})

const bases = computed(() => props.report?.bases ?? [])
const hasReport = computed(
  () => props.report?.status === 'ready' && bases.value.length > 0,
)
const isWorking = computed(() =>
  ['snapshotting', 'parsing'].includes(props.report?.status || ''),
)

function toggle(id: string) {
  expanded.value = { ...expanded.value, [id]: !expanded.value[id] }
}

function ownerLabel(base: BaseCamp) {
  if (base.ownerNames?.length) return base.ownerNames.join(', ')
  if (base.ownerPlayerUids?.length) {
    return base.ownerPlayerUids.map((u) => u.slice(0, 8)).join(', ')
  }
  return 'Unknown'
}

function locLabel(base: BaseCamp) {
  const x = base.location?.x
  const y = base.location?.y
  if (x == null || y == null) return '—'
  return `${Math.round(x)}, ${Math.round(y)}`
}

function statusColor(status: string) {
  if (status === 'hungry') return 'warning'
  if (status === 'injured') return 'error'
  if (status === 'working') return 'success'
  return 'neutral'
}

function updatedLabel() {
  if (!props.report?.updatedAt) return null
  return new Date(props.report.updatedAt).toLocaleString()
}
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-start justify-between gap-3">
        <div>
          <h2 class="text-base font-semibold">Bases at logout</h2>
          <p class="text-xs text-muted">
            Read-only snapshot from the last empty-world stop (never parses the live save)
          </p>
        </div>
        <div class="flex items-center gap-2">
          <UBadge
            v-if="report?.status === 'ready'"
            color="success"
            variant="subtle"
          >
            {{ report.stats?.baseCount ?? bases.length }} bases
          </UBadge>
          <UBadge
            v-else-if="isWorking"
            color="warning"
            variant="subtle"
          >
            {{ report?.status === 'snapshotting' ? 'Snapshotting…' : 'Parsing…' }}
          </UBadge>
          <UBadge
            v-else-if="report?.status === 'error'"
            color="error"
            variant="subtle"
          >
            Error
          </UBadge>
          <UBadge
            v-else
            color="neutral"
            variant="subtle"
          >
            No snapshot
          </UBadge>
          <UButton
            icon="i-lucide-refresh-cw"
            color="neutral"
            variant="ghost"
            size="sm"
            square
            :loading="busy || isWorking"
            title="Refresh snapshot now"
            @click="emit('refresh')"
          />
        </div>
      </div>
    </template>

    <div class="flex flex-col gap-3">
      <UAlert
        v-if="report?.error"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="report.error.message"
        :description="report.error.code === 'unsupported_save_version'
          ? 'Palworld save format is newer than the pinned parser.'
          : (report.error.code || undefined)"
      />

      <p
        v-if="!hasReport && !report?.error && !isWorking"
        class="text-sm text-muted"
      >
        No logout report yet. After the world goes empty and the container stops
        (autostop or Stop), a snapshot is copied and parsed here.
      </p>

      <p
        v-if="report?.updatedAt && (hasReport || report?.error)"
        class="text-xs text-muted"
      >
        Last update {{ updatedLabel() }}
        <span v-if="report.trigger"> · {{ report.trigger }}</span>
        <span v-if="report.stats">
          · {{ report.stats.palAtBases }} pals at bases
        </span>
      </p>

      <div
        v-for="base in bases"
        :key="base.id"
        class="rounded-lg border border-default"
      >
        <button
          type="button"
          class="flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left hover:bg-elevated/60"
          @click="toggle(base.id)"
        >
          <div class="min-w-0">
            <p class="truncate text-sm font-medium">
              {{ base.name || `Base ${base.id.slice(0, 8)}` }}
            </p>
            <p class="text-xs text-muted">
              Owner {{ ownerLabel(base) }} · {{ locLabel(base) }} ·
              {{ base.palCount }} pals
            </p>
          </div>
          <UIcon
            :name="expanded[base.id] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
            class="mt-0.5 size-4 shrink-0 text-muted"
          />
        </button>

        <div
          v-if="expanded[base.id]"
          class="border-t border-default px-3 py-2"
        >
          <div
            v-if="!base.pals?.length"
            class="py-2 text-xs text-muted"
          >
            No pals assigned to this base’s worker slots.
          </div>
          <ul
            v-else
            class="divide-y divide-default"
          >
            <li
              v-for="pal in base.pals"
              :key="pal.instanceId || `${pal.species}-${pal.slotIndex}`"
              class="flex items-center justify-between gap-3 py-2 text-sm"
            >
              <div class="min-w-0">
                <p class="truncate font-medium">
                  {{ pal.species }}
                  <span class="text-muted font-normal">Lv {{ pal.level ?? '—' }}</span>
                </p>
                <p class="text-xs text-muted">
                  <span v-if="pal.ownerName">{{ pal.ownerName }} · </span>
                  <span v-if="pal.fullStomach != null">hunger {{ Math.round(pal.fullStomach) }}</span>
                  <span v-if="pal.hp != null"> · HP {{ pal.hp }}</span>
                </p>
              </div>
              <UBadge
                :color="statusColor(pal.status)"
                variant="subtle"
                size="sm"
              >
                {{ pal.status }}
              </UBadge>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </UCard>
</template>
