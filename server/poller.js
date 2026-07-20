import { config } from './config.js'
import { palworld } from './palworld.js'
import { readIniSummary } from './ini.js'
import { state, broadcast } from './state.js'

let timer = null
let iniTimer = null

async function tick() {
  try {
    const [info, metrics, playersRes] = await Promise.all([
      palworld.info(),
      palworld.metrics(),
      palworld.players(),
    ])

    let settings = state.settings
    try {
      settings = await palworld.settings()
    } catch {
      // settings can fail on some builds; keep last
    }

    state.palworldReachable = true
    state.error = null
    state.info = info
    state.metrics = metrics
    state.players = playersRes?.players || playersRes || []
    if (!Array.isArray(state.players)) state.players = []
    state.settings = settings
    state.updatedAt = Date.now()

    broadcast('status', {
      palworldReachable: true,
      error: null,
    })
    broadcast('server', {
      info: state.info,
      metrics: state.metrics,
      ts: state.updatedAt,
    })
    broadcast('players', {
      players: state.players,
      ts: state.updatedAt,
    })
  } catch (err) {
    state.palworldReachable = false
    state.error = err.message || String(err)
    state.updatedAt = Date.now()
    broadcast('status', {
      palworldReachable: false,
      error: state.error,
    })
  }
}

// Exported so route handlers can force an immediate re-read + settings
// broadcast right after the ini file is edited/restored, instead of waiting
// for the 60s poll.
export async function refreshIni() {
  try {
    state.iniSummary = await readIniSummary()
    broadcast('settings', {
      api: state.settings,
      ini: state.iniSummary,
      ts: Date.now(),
    })
  } catch (err) {
    console.warn('[ini] read failed:', err.message)
  }
}

export function startPoller() {
  tick()
  refreshIni()
  timer = setInterval(tick, config.pollIntervalMs)
  iniTimer = setInterval(refreshIni, 60_000)
}

export function stopPoller() {
  if (timer) clearInterval(timer)
  if (iniTimer) clearInterval(iniTimer)
  timer = null
  iniTimer = null
}
