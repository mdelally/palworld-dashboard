import { watch, open, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { config } from './config.js'
import { state, broadcast } from './state.js'

let watcher = null
let activePath = null
let followTimer = null
let offset = 0
let stopped = false

function pushLine(line) {
  const entry = { line, ts: Date.now() }
  state.logBuffer.push(entry)
  if (state.logBuffer.length > config.logBufferLines) {
    state.logBuffer.splice(0, state.logBuffer.length - config.logBufferLines)
  }
  broadcast('log', entry)
}

async function resolveLogFile(logPath) {
  try {
    const st = await stat(logPath)
    if (st.isFile()) return logPath
    if (st.isDirectory()) {
      const { readdir } = await import('node:fs/promises')
      const files = await readdir(logPath)
      const candidates = files
        .filter((f) => /\.(log|txt)$/i.test(f) || /pal/i.test(f))
        .map((f) => path.join(logPath, f))
      if (candidates.length === 0) return null
      let newest = candidates[0]
      let newestMtime = 0
      for (const file of candidates) {
        try {
          const s = await stat(file)
          if (s.mtimeMs >= newestMtime) {
            newestMtime = s.mtimeMs
            newest = file
          }
        } catch {
          /* skip */
        }
      }
      return newest
    }
  } catch {
    return null
  }
  return null
}

async function seedBuffer(filePath) {
  const fh = await open(filePath, 'r')
  try {
    const st = await fh.stat()
    const start = Math.max(0, st.size - 256 * 1024)
    offset = st.size
    if (st.size === 0) return

    const stream = createReadStream(filePath, { start, end: st.size - 1 })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    const lines = []
    for await (const line of rl) {
      if (line) lines.push(line)
    }
    const keep = lines.slice(-config.logBufferLines)
    state.logBuffer = keep.map((line) => ({ line, ts: Date.now() }))
  } finally {
    await fh.close()
  }
}

async function readNewBytes(filePath) {
  const st = await stat(filePath)
  if (st.size < offset) {
    // rotated / truncated
    offset = 0
    state.logBuffer = []
  }
  if (st.size === offset) return

  const stream = createReadStream(filePath, { start: offset, end: st.size - 1 })
  offset = st.size
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    if (line) pushLine(line)
  }
}

function scheduleFollow(filePath) {
  if (followTimer) clearInterval(followTimer)
  followTimer = setInterval(() => {
    readNewBytes(filePath).catch((err) => {
      broadcast('status', {
        palworldReachable: state.palworldReachable,
        error: state.error,
        logError: err.message,
      })
    })
  }, 1000)
}

async function attachTo(filePath) {
  if (activePath === filePath) return
  activePath = filePath
  await seedBuffer(filePath)
  scheduleFollow(filePath)
  broadcast('status', {
    palworldReachable: state.palworldReachable,
    error: state.error,
    logPath: filePath,
  })
}

export async function startLogTail() {
  const logPath = config.palworld.logPath
  if (!logPath) {
    console.warn('[log] PALWORLD_LOG_PATH not set — log streaming disabled')
    return
  }

  stopped = false

  const tryAttach = async () => {
    if (stopped) return
    const file = await resolveLogFile(logPath)
    if (file) {
      try {
        await attachTo(file)
      } catch (err) {
        console.warn('[log] attach failed:', err.message)
      }
    }
  }

  await tryAttach()

  try {
    watcher = watch(logPath, { recursive: true }, () => {
      tryAttach()
    })
  } catch (err) {
    console.warn('[log] watch unavailable, polling only:', err.message)
    setInterval(tryAttach, 5000)
  }
}

export function stopLogTail() {
  stopped = true
  if (followTimer) clearInterval(followTimer)
  followTimer = null
  if (watcher) {
    watcher.close().catch(() => {})
    watcher = null
  }
}
