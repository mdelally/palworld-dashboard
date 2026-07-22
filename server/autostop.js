import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { palworld } from './palworld.js'
import { stopContainer, getContainerState } from './dockerControl.js'
import { state, broadcast } from './state.js'
import { queueSnapshotAndParse } from './saveReport.js'

// Idle autostop: when the world goes empty, arm a countdown. On expiry, save
// the world and Docker-stop the game container (leave it down). Any login
// while armed cancels the timer; it only re-arms on the next empty transition.

export const ALLOWED_DELAY_MINUTES = [30, 45, 60, 120]

const DEFAULTS = {
  enabled: false,
  delayMinutes: 60,
}

let settings = { ...DEFAULTS }
let loaded = false
let prevPlayerCount = null
let armedAt = null
let deadlineAt = null
let timer = null
let stopping = false
let lastNotice = null
let containerRunning = null
let containerStatus = null
let containerPollTimer = null

function settingsPath() {
  return path.join(config.dataDir, 'autostop.json')
}

function broadcastAutostop(notice) {
  if (notice) lastNotice = notice
  const payload = snapshot()
  if (notice) payload.notice = notice
  broadcast('autostop', payload)
  if (notice) {
    broadcast('status', {
      palworldReachable: state.palworldReachable,
      error: state.error,
      notice,
    })
  }
}

export function snapshot() {
  return {
    enabled: settings.enabled,
    delayMinutes: settings.delayMinutes,
    allowedDelayMinutes: ALLOWED_DELAY_MINUTES,
    armed: deadlineAt != null && !stopping,
    armedAt,
    deadlineAt,
    remainingMs:
      deadlineAt != null && !stopping ? Math.max(0, deadlineAt - Date.now()) : null,
    stopping,
    containerRunning,
    containerStatus,
    notice: lastNotice,
  }
}

async function persist() {
  try {
    await mkdir(config.dataDir, { recursive: true })
    await writeFile(
      settingsPath(),
      JSON.stringify(
        { enabled: settings.enabled, delayMinutes: settings.delayMinutes },
        null,
        2,
      ),
      'utf8',
    )
  } catch (err) {
    console.warn('[autostop] persist failed:', err.message)
  }
}

export async function loadAutostopSettings() {
  if (loaded) return settings
  loaded = true
  try {
    const raw = await readFile(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed.enabled === 'boolean') settings.enabled = parsed.enabled
    if (ALLOWED_DELAY_MINUTES.includes(Number(parsed.delayMinutes))) {
      settings.delayMinutes = Number(parsed.delayMinutes)
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[autostop] load failed, using defaults:', err.message)
    }
  }
  return settings
}

function clearTimer() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

function disarm(reason) {
  const wasArmed = deadlineAt != null
  clearTimer()
  armedAt = null
  deadlineAt = null
  if (wasArmed && reason) broadcastAutostop(reason)
  else if (wasArmed) broadcastAutostop()
}

function arm() {
  clearTimer()
  armedAt = Date.now()
  deadlineAt = armedAt + settings.delayMinutes * 60_000
  const remaining = Math.max(0, deadlineAt - Date.now())
  timer = setTimeout(() => {
    fireStop().catch((err) => {
      console.error('[autostop] stop failed:', err)
      stopping = false
      broadcastAutostop(`Autostop failed: ${err.message}`)
    })
  }, remaining)
  broadcastAutostop(
    `Server empty — autostop in ${settings.delayMinutes} min`,
  )
}

async function fireStop() {
  if (stopping) return
  stopping = true
  clearTimer()
  broadcastAutostop('Autostop: saving world and stopping container…')

  try {
    try {
      await palworld.save()
    } catch (err) {
      console.warn('[autostop] save failed (continuing to stop):', err.message)
    }
    // Copy after the save above. Inner snapshotAndParse also tries save()
    // best-effort; skip the duplicate when the caller already flushed.
    queueSnapshotAndParse({ trigger: 'autostop', saveBeforeSnapshot: false })
    await stopContainer({ timeoutSeconds: 30 })
    containerRunning = false
    containerStatus = 'exited'
    armedAt = null
    deadlineAt = null
    stopping = false
    broadcastAutostop('Autostop: container stopped')
  } catch (err) {
    stopping = false
    throw err
  }
}

/**
 * Called from the poller after each successful/failed player refresh.
 * @param {{ reachable: boolean, playerCount: number }} info
 */
export function onPlayersTick({ reachable, playerCount }) {
  if (!loaded) return

  // While stopping, ignore churn.
  if (stopping) {
    prevPlayerCount = playerCount
    return
  }

  // Unreachable / container down: don't arm, and cancel any pending timer
  // (can't usefully stop what's already gone; also avoids false arms).
  if (!reachable) {
    if (deadlineAt != null) disarm('Autostop cancelled — server unreachable')
    prevPlayerCount = playerCount
    return
  }

  if (!settings.enabled) {
    if (deadlineAt != null) disarm('Autostop disabled')
    prevPlayerCount = playerCount
    return
  }

  const prev = prevPlayerCount
  prevPlayerCount = playerCount

  // Need a prior observation so we only arm on a real N→0 transition,
  // not on dashboard boot into an already-empty world.
  if (prev == null) return

  if (playerCount > 0) {
    if (deadlineAt != null) {
      disarm('Player joined — autostop cancelled')
    }
    return
  }

  // playerCount === 0
  if (prev > 0 && deadlineAt == null) {
    arm()
  }
}

export async function updateAutostopSettings({ enabled, delayMinutes } = {}) {
  await loadAutostopSettings()

  let changed = false
  if (typeof enabled === 'boolean' && enabled !== settings.enabled) {
    settings.enabled = enabled
    changed = true
  }
  if (
    delayMinutes != null &&
    ALLOWED_DELAY_MINUTES.includes(Number(delayMinutes)) &&
    Number(delayMinutes) !== settings.delayMinutes
  ) {
    settings.delayMinutes = Number(delayMinutes)
    changed = true
  }

  if (!changed) return snapshot()

  await persist()

  if (!settings.enabled) {
    disarm('Autostop disabled')
    return snapshot()
  }

  // Delay changed while armed: re-arm from now with the new delay so the
  // countdown matches what the admin just picked.
  if (deadlineAt != null) {
    arm()
  } else {
    broadcastAutostop()
  }

  return snapshot()
}

export function cancelAutostop(reason = 'Autostop cancelled') {
  if (deadlineAt == null) return snapshot()
  disarm(reason)
  return snapshot()
}

export async function refreshContainerState() {
  try {
    const info = await getContainerState()
    if (!info) {
      containerRunning = null
      containerStatus = null
    } else {
      containerRunning = info.running
      containerStatus = info.status
    }
  } catch (err) {
    console.warn('[autostop] container inspect failed:', err.message)
  }
  return snapshot()
}

export function startAutostop() {
  loadAutostopSettings()
    .then(() => refreshContainerState())
    .then(() => broadcastAutostop())
    .catch((err) => console.warn('[autostop] start failed:', err.message))

  if (containerPollTimer) clearInterval(containerPollTimer)
  // Keep the Start button honest even when REST is down.
  containerPollTimer = setInterval(() => {
    refreshContainerState()
      .then((snap) => broadcast('autostop', snap))
      .catch(() => {})
  }, 10_000)
}

export function stopAutostop() {
  clearTimer()
  if (containerPollTimer) {
    clearInterval(containerPollTimer)
    containerPollTimer = null
  }
}
