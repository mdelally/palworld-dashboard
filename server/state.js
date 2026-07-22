/** Shared live cache + SSE fan-out */

import { config } from './config.js'
import { listBans } from './banlist.js'
import { snapshot as autostopSnapshot } from './autostop.js'
import { snapshotForClient as basesSnapshot } from './saveReport.js'

const clients = new Set()

export const state = {
  palworldReachable: false,
  error: null,
  info: null,
  metrics: null,
  players: [],
  settings: null,
  iniSummary: null,
  updatedAt: null,
  logBuffer: [],
}

export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const client of clients) {
    try {
      client.write(payload)
    } catch {
      clients.delete(client)
    }
  }
}

let excludeRe = null
let excludeCompiled = false
function getExcludeRe() {
  if (!excludeCompiled) {
    excludeCompiled = true
    if (config.logExclude) {
      try {
        excludeRe = new RegExp(config.logExclude)
      } catch {
        console.warn('[log] invalid LOG_EXCLUDE regex — ignoring')
      }
    }
  }
  return excludeRe
}

/** Append a single log line to the ring buffer and fan it out over SSE. */
export function pushLogLine(line) {
  const re = getExcludeRe()
  if (re && re.test(line)) return
  const entry = { line, ts: Date.now() }
  state.logBuffer.push(entry)
  if (state.logBuffer.length > config.logBufferLines) {
    state.logBuffer.splice(0, state.logBuffer.length - config.logBufferLines)
  }
  broadcast('log', entry)
}

export function addSseClient(reply) {
  clients.add(reply.raw)
  return () => clients.delete(reply.raw)
}

export function snapshotForClient() {
  return {
    status: {
      palworldReachable: state.palworldReachable,
      error: state.error,
    },
    server: {
      info: state.info,
      metrics: state.metrics,
      ts: state.updatedAt,
    },
    players: {
      players: state.players,
      ts: state.updatedAt,
    },
    settings: {
      api: state.settings,
      ini: state.iniSummary,
      ts: state.updatedAt,
    },
    bans: {
      bans: listBans(),
    },
    autostop: autostopSnapshot(),
    bases: basesSnapshot(),
    logs: state.logBuffer,
  }
}
