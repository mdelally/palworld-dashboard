import http from 'node:http'
import { config } from './config.js'

// Mutating Docker Engine API calls over the mounted unix socket. Currently
// just container restart (for the dashboard's restart action). Mirrors the
// http.request({ socketPath }) pattern in dockerLogs.js.
//
// Note: mounting docker.sock read-only does NOT make the API read-only — the
// :ro flag only affects the socket inode, not requests sent over it — so
// POST /restart works with the existing compose mount.

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

export async function restartContainer() {
  const container = config.palworld.container
  if (!container) {
    throw new Error('PALWORLD_CONTAINER not set — cannot restart')
  }
  const { statusCode, body } = await dockerRequest(
    'POST',
    `/containers/${encodeURIComponent(container)}/restart?t=10`,
  )
  // Docker returns 204 No Content on success; 404 unknown container, 500 error.
  if (statusCode !== 204) {
    let message = `Docker restart failed: HTTP ${statusCode}`
    try {
      const parsed = JSON.parse(body)
      if (parsed?.message) message = parsed.message
    } catch {
      if (body) message += ` ${body.slice(0, 200)}`
    }
    const err = new Error(message)
    err.status = statusCode === 404 ? 404 : 502
    throw err
  }
}
