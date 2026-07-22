import http from 'node:http'
import { config } from './config.js'

// Mutating Docker Engine API calls over the mounted unix socket.
// Mirrors the http.request({ socketPath }) pattern in dockerLogs.js.
//
// Note: mounting docker.sock read-only does NOT make the API read-only — the
// :ro flag only affects the socket inode, not requests sent over it — so
// POST /start|/stop|/restart work with the existing compose mount.

function dockerRequest(method, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: config.dockerSocket, path: pathname, method },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => resolve({ statusCode: res.statusCode, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function requireContainer() {
  const container = config.palworld.container
  if (!container) {
    const err = new Error('PALWORLD_CONTAINER not set — cannot control game container')
    err.status = 503
    throw err
  }
  return container
}

function dockerError(action, statusCode, body) {
  let message = `Docker ${action} failed: HTTP ${statusCode}`
  try {
    const parsed = JSON.parse(body)
    if (parsed?.message) message = parsed.message
  } catch {
    if (body) message += ` ${body.slice(0, 200)}`
  }
  const err = new Error(message)
  err.status = statusCode === 404 ? 404 : 502
  return err
}

export async function restartContainer() {
  const container = requireContainer()
  const { statusCode, body } = await dockerRequest(
    'POST',
    `/containers/${encodeURIComponent(container)}/restart?t=10`,
  )
  // Docker returns 204 No Content on success; 404 unknown container, 500 error.
  if (statusCode !== 204) {
    throw dockerError('restart', statusCode, body)
  }
}

export async function stopContainer({ timeoutSeconds = 30 } = {}) {
  const container = requireContainer()
  const t = Math.max(1, Math.min(120, Number(timeoutSeconds) || 30))
  const { statusCode, body } = await dockerRequest(
    'POST',
    `/containers/${encodeURIComponent(container)}/stop?t=${t}`,
  )
  // 204 success; 304 already stopped — treat both as success for idempotency.
  if (statusCode !== 204 && statusCode !== 304) {
    throw dockerError('stop', statusCode, body)
  }
  return { alreadyStopped: statusCode === 304 }
}

export async function startContainer() {
  const container = requireContainer()
  const { statusCode, body } = await dockerRequest(
    'POST',
    `/containers/${encodeURIComponent(container)}/start`,
  )
  // 204 success; 304 already started.
  if (statusCode !== 204 && statusCode !== 304) {
    throw dockerError('start', statusCode, body)
  }
  return { alreadyStarted: statusCode === 304 }
}

/** Inspect the game container. Returns null when no container is configured. */
export async function getContainerState() {
  const container = config.palworld.container
  if (!container) return null
  const { statusCode, body } = await dockerRequest(
    'GET',
    `/containers/${encodeURIComponent(container)}/json`,
  )
  if (statusCode === 404) {
    return {
      name: container,
      exists: false,
      running: false,
      status: 'not found',
    }
  }
  if (statusCode !== 200) {
    throw dockerError('inspect', statusCode, body)
  }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    throw dockerError('inspect', statusCode, body)
  }
  return {
    name: container,
    exists: true,
    running: Boolean(parsed?.State?.Running),
    status: parsed?.State?.Status || 'unknown',
  }
}
