import http from 'node:http'
import { config } from './config.js'
import { state, pushLogLine, broadcast } from './state.js'

// Streams a game-server container's stdout/stderr via the Docker Engine API
// over the mounted unix socket. This is the right source when Palworld runs
// in its own container (the common case) and logs to the console rather than
// to a Pal.log file on disk.

let stopped = false
let currentRes = null
let reconnectTimer = null

function dockerGet(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: config.dockerSocket, path: pathname, method: 'GET' },
      (res) => resolve(res),
    )
    req.on('error', reject)
    req.end()
  })
}

async function readBody(res) {
  let body = ''
  for await (const chunk of res) body += chunk
  return body
}

async function inspectTty(container) {
  const res = await dockerGet(`/containers/${encodeURIComponent(container)}/json`)
  const body = await readBody(res)
  if (res.statusCode !== 200) {
    throw new Error(`inspect ${container}: HTTP ${res.statusCode} ${body.slice(0, 200)}`)
  }
  const info = JSON.parse(body)
  return Boolean(info?.Config?.Tty)
}

// Splits incoming text into complete lines, holding any trailing partial line
// until the rest arrives in a later chunk/frame.
function makeLineEmitter() {
  let buf = ''
  return (text) => {
    buf += text
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (line) pushLogLine(line)
    }
  }
}

// Non-TTY containers return a multiplexed stream: each frame is an 8-byte
// header (stream type + big-endian uint32 payload length) followed by payload.
function attachMultiplexed(res, emit) {
  let acc = Buffer.alloc(0)
  res.on('data', (chunk) => {
    acc = Buffer.concat([acc, chunk])
    while (acc.length >= 8) {
      const len = acc.readUInt32BE(4)
      if (acc.length < 8 + len) break
      emit(acc.subarray(8, 8 + len).toString('utf8'))
      acc = acc.subarray(8 + len)
    }
  })
}

// TTY containers stream raw bytes with no framing.
function attachRaw(res, emit) {
  res.setEncoding('utf8')
  res.on('data', (chunk) => emit(chunk))
}

async function follow(container, tty) {
  const tail = config.logBufferLines
  const res = await dockerGet(
    `/containers/${encodeURIComponent(container)}/logs` +
      `?follow=1&stdout=1&stderr=1&tail=${tail}&timestamps=0`,
  )
  if (res.statusCode !== 200) {
    const body = await readBody(res)
    throw new Error(`logs ${container}: HTTP ${res.statusCode} ${body.slice(0, 200)}`)
  }

  currentRes = res
  // A fresh follow re-seeds the buffer from `tail`, so clear stale lines.
  state.logBuffer = []
  const emit = makeLineEmitter()
  if (tty) attachRaw(res, emit)
  else attachMultiplexed(res, emit)

  broadcast('status', {
    palworldReachable: state.palworldReachable,
    error: state.error,
    logSource: `docker:${container}`,
  })

  await new Promise((resolve, reject) => {
    res.on('end', resolve)
    res.on('close', resolve)
    res.on('error', reject)
  })
}

export async function startDockerLogs() {
  const container = config.palworld.container
  if (!container) {
    console.warn('[log] PALWORLD_CONTAINER not set — docker log streaming disabled')
    return
  }
  stopped = false

  const loop = async () => {
    if (stopped) return
    try {
      const tty = await inspectTty(container)
      await follow(container, tty)
    } catch (err) {
      broadcast('status', {
        palworldReachable: state.palworldReachable,
        error: state.error,
        logError: err.message,
      })
      console.warn('[log] docker log stream error:', err.message)
    }
    if (!stopped) reconnectTimer = setTimeout(loop, 3000)
  }

  loop()
}

export function stopDockerLogs() {
  stopped = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  if (currentRes) {
    try {
      currentRes.destroy()
    } catch {
      /* ignore */
    }
    currentRes = null
  }
}
