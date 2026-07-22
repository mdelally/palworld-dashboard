<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

export type SparkPoint = { t: number; v: number }

const props = withDefaults(
  defineProps<{
    points: SparkPoint[]
    /** Visible time window ending at "now". */
    windowMs?: number
    /** Optional fixed floor for the Y domain (FPS uses 0). */
    yMin?: number
    /** Soft ceiling — raised automatically when samples exceed it. */
    ySoftMax?: number
    ariaLabel?: string
  }>(),
  {
    windowMs: 30 * 60 * 1000,
    yMin: 0,
    ySoftMax: 60,
    ariaLabel: 'Metric history',
  },
)

const WIDTH = 120
const HEIGHT = 36
const PAD_Y = 2

const now = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  tickTimer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
})

const visible = computed(() => {
  const cutoff = now.value - props.windowMs
  return props.points.filter((p) => p.t >= cutoff && Number.isFinite(p.v))
})

const yMax = computed(() => {
  let max = props.ySoftMax
  for (const p of visible.value) max = Math.max(max, p.v)
  return max
})

function xFor(t: number) {
  const start = now.value - props.windowMs
  const span = props.windowMs || 1
  return ((t - start) / span) * WIDTH
}

function yFor(v: number) {
  const min = props.yMin
  const range = Math.max(1e-6, yMax.value - min)
  const norm = (v - min) / range
  return HEIGHT - PAD_Y - norm * (HEIGHT - PAD_Y * 2)
}

const linePath = computed(() => {
  const pts = visible.value
  if (pts.length === 0) return ''
  let d = ''
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!
    const cmd = i === 0 ? 'M' : 'L'
    d += `${cmd}${xFor(p.t).toFixed(2)} ${yFor(p.v).toFixed(2)} `
  }
  return d.trim()
})

const areaPath = computed(() => {
  const pts = visible.value
  if (pts.length === 0) return ''
  const firstX = xFor(pts[0]!.t)
  const lastX = xFor(pts[pts.length - 1]!.t)
  const baseline = HEIGHT
  return `${linePath.value} L${lastX.toFixed(2)} ${baseline} L${firstX.toFixed(2)} ${baseline} Z`
})

const empty = computed(() => visible.value.length < 2)

const windowLabel = computed(() => {
  const minutes = Math.round(props.windowMs / 60_000)
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
})
</script>

<template>
  <div class="w-full">
    <svg
      class="block h-9 w-full text-primary"
      :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
      preserveAspectRatio="none"
      role="img"
      :aria-label="ariaLabel"
    >
      <path
        v-if="!empty"
        :d="areaPath"
        fill="currentColor"
        opacity="0.15"
      />
      <path
        v-if="!empty"
        :d="linePath"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linejoin="round"
        stroke-linecap="round"
        vector-effect="non-scaling-stroke"
      />
      <line
        v-if="empty"
        :x1="0"
        :x2="WIDTH"
        :y1="HEIGHT / 2"
        :y2="HEIGHT / 2"
        class="text-muted"
        stroke="currentColor"
        stroke-width="1"
        stroke-dasharray="3 3"
        vector-effect="non-scaling-stroke"
        opacity="0.5"
      />
    </svg>
    <div class="mt-0.5 flex justify-between text-[10px] leading-none text-muted">
      <span>{{ windowLabel }}</span>
      <span>now</span>
    </div>
  </div>
</template>
