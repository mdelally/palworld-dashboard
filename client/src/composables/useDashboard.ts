import { onMounted, onUnmounted, reactive, ref } from 'vue'
import type { IniSummary, LogEntry, Player, ServerInfo, ServerMetrics } from '../types'

const MAX_LOG_LINES = 500

export function useDashboard() {
  const connected = ref(false)
  const palworldReachable = ref(false)
  const error = ref<string | null>(null)
  const notice = ref<string | null>(null)
  const updatedAt = ref<number | null>(null)
  const info = ref<ServerInfo | null>(null)
  const metrics = ref<ServerMetrics | null>(null)
  const players = ref<Player[]>([])
  const settingsApi = ref<Record<string, unknown> | null>(null)
  const settingsIni = ref<IniSummary | null>(null)
  const logs = reactive<LogEntry[]>([])
  const actionBusy = ref(false)
  const actionError = ref<string | null>(null)

  let es: EventSource | null = null
  let paused = false
  const logPaused = ref(false)

  function setPaused(value: boolean) {
    paused = value
    logPaused.value = value
  }

  function clearLogs() {
    logs.splice(0, logs.length)
  }

  function pushLog(entry: LogEntry) {
    if (paused) return
    logs.push(entry)
    if (logs.length > MAX_LOG_LINES) {
      logs.splice(0, logs.length - MAX_LOG_LINES)
    }
  }

  function connect() {
    if (es) es.close()
    es = new EventSource('/api/events')

    es.onopen = () => {
      connected.value = true
    }

    es.onerror = () => {
      connected.value = false
    }

    es.addEventListener('status', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data)
      palworldReachable.value = !!data.palworldReachable
      error.value = data.error ?? null
      if (data.notice) notice.value = data.notice
    })

    es.addEventListener('server', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data)
      info.value = data.info ?? null
      metrics.value = data.metrics ?? null
      updatedAt.value = data.ts ?? Date.now()
    })

    es.addEventListener('players', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data)
      players.value = Array.isArray(data.players) ? data.players : []
      updatedAt.value = data.ts ?? Date.now()
    })

    es.addEventListener('settings', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data)
      settingsApi.value = data.api ?? null
      settingsIni.value = data.ini ?? null
    })

    es.addEventListener('log', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as LogEntry
      pushLog(data)
    })
  }

  async function announce(message: string) {
    actionBusy.value = true
    actionError.value = null
    try {
      const res = await fetch('/api/announce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'Announce failed')
      notice.value = 'Announcement sent'
    } catch (err) {
      actionError.value = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      actionBusy.value = false
    }
  }

  async function saveWorld() {
    actionBusy.value = true
    actionError.value = null
    try {
      const res = await fetch('/api/save', { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'Save failed')
      notice.value = 'World save requested'
    } catch (err) {
      actionError.value = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      actionBusy.value = false
    }
  }

  onMounted(() => connect())
  onUnmounted(() => {
    es?.close()
    es = null
  })

  return {
    connected,
    palworldReachable,
    error,
    notice,
    updatedAt,
    info,
    metrics,
    players,
    settingsApi,
    settingsIni,
    logs,
    logPaused,
    actionBusy,
    actionError,
    setPaused,
    clearLogs,
    announce,
    saveWorld,
  }
}

export function pickServerName(info: ServerInfo | null, ini: IniSummary | null) {
  return (
    info?.servername ||
    info?.serverName ||
    ini?.serverName ||
    (typeof info?.name === 'string' ? info.name : null) ||
    'Palworld Server'
  )
}

export function pickMetric(metrics: ServerMetrics | null, camel: string, lower: string) {
  if (!metrics) return null
  const v = metrics[camel] ?? metrics[lower]
  return typeof v === 'number' ? v : v != null ? Number(v) : null
}

export function formatUptime(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds)) return '—'
  const s = Math.max(0, Math.floor(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
