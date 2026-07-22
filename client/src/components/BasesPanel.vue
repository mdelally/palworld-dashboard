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

function formatCount(n: number) {
  return n.toLocaleString()
}

function statusColor(status: string) {
  if (status === 'hungry' || status === 'starving' || status === 'slacking') return 'warning'
  if (status === 'injured' || status === 'sick') return 'error'
  if (status === 'working') return 'success'
  return 'neutral'
}

function palDisplayName(pal: BasePal) {
  if (pal.nickName) return pal.nickName
  return pal.species
}

/** Game UI treats these as /100 meters. */
const METER_MAX = 100

function meterValue(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return null
  return Math.max(0, Math.min(METER_MAX, Math.round(value)))
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

function rankStars(rank: number | null | undefined) {
  const filled = Math.max(0, Math.min(4, rank ?? 0))
  return { filled, empty: 4 - filled }
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
          <h2 class="text-base font-semibold">Bases snapshot</h2>
          <p class="text-xs text-muted">
            Read-only report from a copied Level.sav (works while the server is up; refresh tries save first)
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
        No snapshot yet. Use refresh anytime (even while the server is running),
        or wait for the next autostop / Stop — both copy Level.sav then parse.
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
              <span v-if="(base.resourceCount ?? base.resources?.length ?? 0) > 0">
                · {{ base.resourceCount ?? base.resources?.length }} resources
              </span>
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
            v-if="base.resources?.length"
            class="mb-3 space-y-1.5"
          >
            <p class="text-[10px] font-medium uppercase tracking-wide text-primary">
              Resources
            </p>
            <ul class="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
              <li
                v-for="res in base.resources"
                :key="res.id"
                class="flex items-baseline justify-between gap-2 text-xs"
              >
                <span class="min-w-0 truncate text-muted">
                  {{ humanize(res.id) }}
                </span>
                <span class="shrink-0 tabular-nums font-medium">
                  ×{{ formatCount(res.count) }}
                </span>
              </li>
            </ul>
          </div>

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
              class="flex gap-3 py-3"
            >
              <!-- Level block (game: left accent + big number) -->
              <div class="w-12 shrink-0 border-l-2 border-primary pl-2">
                <p class="text-[10px] font-medium uppercase tracking-wide text-primary">
                  Level
                </p>
                <p class="text-xl font-semibold leading-none tabular-nums">
                  {{ pal.level ?? '—' }}
                </p>
              </div>

              <div class="min-w-0 flex-1 space-y-2">
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <p class="truncate text-sm font-semibold">
                      {{ palDisplayName(pal) }}
                    </p>
                    <p
                      v-if="pal.nickName"
                      class="truncate text-xs text-muted"
                    >
                      {{ pal.species }}
                    </p>
                    <p
                      v-if="pal.ownerName"
                      class="truncate text-xs text-muted"
                    >
                      {{ pal.ownerName }}
                    </p>
                    <div
                      v-if="(pal.rank != null && pal.rank > 0) || pal.isRare"
                      class="mt-1 flex items-center gap-1.5"
                    >
                      <div
                        v-if="pal.rank != null && pal.rank > 0"
                        class="flex items-center gap-0.5"
                        :title="`Rank ${pal.rank}`"
                      >
                        <UIcon
                          v-for="i in rankStars(pal.rank).filled"
                          :key="`f-${i}`"
                          name="i-lucide-star"
                          class="size-3 text-warning"
                        />
                        <UIcon
                          v-for="i in rankStars(pal.rank).empty"
                          :key="`e-${i}`"
                          name="i-lucide-star"
                          class="size-3 text-muted opacity-40"
                        />
                      </div>
                      <UBadge
                        v-if="pal.isRare"
                        color="warning"
                        variant="subtle"
                        size="sm"
                      >
                        Rare
                      </UBadge>
                    </div>
                  </div>
                  <UBadge
                    :color="statusColor(pal.status)"
                    variant="subtle"
                    size="sm"
                    class="shrink-0"
                  >
                    {{ pal.status }}
                  </UBadge>
                </div>

                <!-- HP / Hunger / SAN — game colors: green / orange / cyan -->
                <div class="space-y-1.5">
                  <div
                    v-if="pal.hp != null"
                    class="flex items-center gap-2"
                  >
                    <span class="w-12 shrink-0 text-[10px] font-medium uppercase tracking-wide text-success">
                      HP
                    </span>
                    <div class="min-w-0 flex-1 rounded-sm bg-success/15 px-2 py-0.5">
                      <p class="text-center text-xs font-medium tabular-nums text-success">
                        {{ pal.hp }}
                      </p>
                    </div>
                  </div>
                  <div
                    v-if="meterValue(pal.fullStomach) != null"
                    class="flex items-center gap-2"
                  >
                    <span class="w-12 shrink-0 text-[10px] font-medium uppercase tracking-wide text-warning">
                      Hunger
                    </span>
                    <UProgress
                      :model-value="meterValue(pal.fullStomach)!"
                      :max="METER_MAX"
                      color="warning"
                      size="md"
                      class="min-w-0 flex-1"
                    />
                    <span class="w-14 shrink-0 text-right text-xs tabular-nums text-muted">
                      {{ meterValue(pal.fullStomach) }}/{{ METER_MAX }}
                    </span>
                  </div>
                  <div
                    v-if="meterValue(pal.sanity) != null"
                    class="flex items-center gap-2"
                  >
                    <span class="w-12 shrink-0 text-[10px] font-medium uppercase tracking-wide text-info">
                      SAN
                    </span>
                    <UProgress
                      :model-value="meterValue(pal.sanity)!"
                      :max="METER_MAX"
                      color="info"
                      size="md"
                      class="min-w-0 flex-1"
                    />
                    <span class="w-14 shrink-0 text-right text-xs tabular-nums text-muted">
                      {{ meterValue(pal.sanity) }}/{{ METER_MAX }}
                    </span>
                  </div>
                </div>

                <div
                  v-if="conditionBadges(pal).length"
                  class="flex flex-wrap gap-1"
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

                <div
                  v-if="pal.passives?.length"
                  class="space-y-1"
                >
                  <p class="text-[10px] font-medium uppercase tracking-wide text-primary">
                    Passive Skills
                  </p>
                  <div class="flex flex-wrap gap-1">
                    <UBadge
                      v-for="passive in pal.passives"
                      :key="passive"
                      color="warning"
                      variant="subtle"
                      size="sm"
                    >
                      {{ humanize(passive) }}
                    </UBadge>
                  </div>
                </div>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </UCard>
</template>
