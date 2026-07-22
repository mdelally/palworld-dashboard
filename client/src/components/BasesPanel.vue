<script setup lang="ts">
import { computed, ref } from 'vue'
import type { BaseCamp, BasePal, BasesReport } from '../types'

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

function baseTitle(base: BaseCamp) {
  return base.name || `Base ${base.id.slice(0, 8)}`
}

function humanize(value: string) {
  // DodgeWork_Sleep → Dodge work sleep; GastricUlcer → Gastric ulcer
  return value
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
}

function statusColor(status: string) {
  if (status === 'hungry' || status === 'starving' || status === 'slacking') return 'warning'
  if (status === 'injured' || status === 'sick') return 'error'
  if (status === 'working') return 'success'
  return 'neutral'
}

function palDisplayName(pal: BasePal) {
  if (pal.nickName) return `${pal.nickName} (${pal.species})`
  return pal.species
}

function palDetailBits(pal: BasePal) {
  const bits: string[] = []
  if (pal.ownerName) bits.push(pal.ownerName)
  if (pal.fullStomach != null) bits.push(`stomach ${Math.round(pal.fullStomach)}`)
  if (pal.sanity != null) bits.push(`sanity ${Math.round(pal.sanity)}`)
  if (pal.hp != null) bits.push(`HP ${pal.hp}`)
  if (pal.rank != null && pal.rank > 0) bits.push(`rank ${pal.rank}`)
  if (pal.isRare) bits.push('rare')
  return bits
}

function conditionBadges(pal: BasePal) {
  const out: Array<{ label: string; color: 'error' | 'warning' | 'neutral' | 'info' }> = []
  if (pal.physicalHealth) {
    out.push({ label: humanize(pal.physicalHealth), color: 'error' })
  }
  if (pal.workerSick) {
    out.push({ label: humanize(pal.workerSick), color: 'error' })
  }
  if (pal.hungerType) {
    out.push({ label: humanize(pal.hungerType), color: 'warning' })
  }
  if (pal.workerEvent) {
    out.push({ label: humanize(pal.workerEvent), color: 'warning' })
  }
  return out
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
              {{ baseTitle(base) }}
            </p>
            <p class="text-xs text-muted">
              Owner {{ ownerLabel(base) }} · {{ locLabel(base) }} ·
              {{ base.palCount }} pals
              <span v-if="base.nameIsDefault"> · default name</span>
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
              class="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-start sm:justify-between"
            >
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium">
                  {{ palDisplayName(pal) }}
                  <span class="text-muted font-normal">Lv {{ pal.level ?? '—' }}</span>
                </p>
                <p
                  v-if="palDetailBits(pal).length"
                  class="text-xs text-muted"
                >
                  {{ palDetailBits(pal).join(' · ') }}
                </p>
                <div
                  v-if="conditionBadges(pal).length"
                  class="mt-1.5 flex flex-wrap gap-1"
                >
                  <UBadge
                    v-for="badge in conditionBadges(pal)"
                    :key="badge.label"
                    :color="badge.color"
                    variant="subtle"
                    size="sm"
                  >
                    {{ badge.label }}
                  </UBadge>
                </div>
                <p
                  v-if="pal.passives?.length"
                  class="mt-1 text-xs text-muted"
                >
                  Passives: {{ pal.passives.map(humanize).join(', ') }}
                </p>
              </div>
              <UBadge
                :color="statusColor(pal.status)"
                variant="subtle"
                size="sm"
                class="shrink-0 self-start"
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
