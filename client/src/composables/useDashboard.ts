import { onMounted, onUnmounted, reactive, ref } from 'vue'
import type { BanEntry, IniSummary, LogEntry, Player, ServerInfo, ServerMetrics } from '../types'

const MAX_LOG_LINES = 500
const TOKEN_KEY = 'palworld-dashboard-token'

export function useDashboard() {
  const connected = ref(false)
  const palworldReachable = ref(false)
  const error = ref<string | null>(null)
  const notice = ref<string | null>(null)
  const updatedAt = ref<number | null>(null)
  const info = ref<ServerInfo | null>(null)
  const metrics = ref<ServerMetrics | null>(null)
  const players = ref<Player[]>([])
  const bans = ref<BanEntry[]>([])
  const settingsApi = ref<Record<string, unknown> | null>(null)
  const settingsIni = ref<IniSummary | null>(null)
  const logs = reactive<LogEntry[]>([])
  const actionBusy = ref(false)
  const actionError = ref<string | null>(null)

  // Admin token for token-gated deploys (DASHBOARD_TOKEN set server-side).
  // Sent as x-dashboard-token on every mutating call. Persisted locally so it
  // survives reloads; ignored by the server when no token is configured.
  const dashboardToken = ref<string>(
    (typeof localStorage !== 'undefined' && localStorage.getItem(TOKEN_KEY)) || '',
  )
  function setDashboardToken(value: string) {
    dashboardToken.value = value
    if (typeof localStorage !== 'undefined') {
      if (value) localStorage.setItem(TOKEN_KEY, value)
      else localStorage.removeItem(TOKEN_KEY)
    }
  }

  // Shared helper for all mutating requests: injects the admin token header,
  // JSON-encodes the body, and surfaces the server's error message.
  async function mutate(path: string, body?: unknown) {
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (dashboardToken.value) headers['x-dashboard-token'] = dashboardToken.value
    const res = await fetch(path, {
      method: 'POST',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const msg =
        res.status === 401
          ? 'Unauthorized — set the admin token'
          : data.error || `Request failed (${res.status})`
      throw new Error(msg)
    }
    return data
  }

  async function runAction(fn: () => Promise<void>) {
    actionBusy.value = true
    actionError.value = null
    try {
      await fn()
    } catch (err) {
      actionError.value = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      actionBusy.value = false
    }
  }

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

    es.addEventListener('bans', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data)
      bans.value = Array.isArray(data.bans) ? data.bans : []
    })

    es.addEventListener('log', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as LogEntry
      pushLog(data)
    })
  }

  async function announce(message: string) {
    await runAction(async () => {
      await mutate('/api/announce', { message })
      notice.value = 'Announcement sent'
    })
  }

  async function saveWorld() {
    await runAction(async () => {
      await mutate('/api/save')
      notice.value = 'World save requested'
    })
  }

  async function kickPlayer(userid: string, name?: string) {
    await runAction(async () => {
      await mutate('/api/kick', { userid })
      notice.value = `Kicked ${name || userid}`
    })
  }

  async function banPlayer(userid: string, name?: string, reason?: string) {
    await runAction(async () => {
      await mutate('/api/ban', { userid, name, message: reason })
      notice.value = `Banned ${name || userid}`
    })
  }

  async function unbanPlayer(userid: string, name?: string) {
    await runAction(async () => {
      await mutate('/api/unban', { userid })
      notice.value = `Unbanned ${name || userid}`
    })
  }

  async function restartServer() {
    await runAction(async () => {
      await mutate('/api/restart')
      notice.value = 'Restart issued — server will come back shortly'
    })
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
    bans,
    settingsApi,
    settingsIni,
    logs,
    logPaused,
    actionBusy,
    actionError,
    dashboardToken,
    setDashboardToken,
    setPaused,
    clearLogs,
    announce,
    saveWorld,
    kickPlayer,
    banPlayer,
    unbanPlayer,
    restartServer,
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
