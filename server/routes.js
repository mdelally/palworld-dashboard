import { config } from './config.js'
import { palworld } from './palworld.js'
import { state, addSseClient, snapshotForClient, broadcast } from './state.js'

function requireToken(request, reply) {
  if (!config.dashboardToken) return true
  const header = request.headers['x-dashboard-token']
  const auth = request.headers.authorization || ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const token = header || bearer
  if (token !== config.dashboardToken) {
    reply.code(401).send({ error: 'Unauthorized' })
    return false
  }
  return true
}

export async function registerRoutes(app) {
  app.get('/api/health', async () => ({
    ok: true,
    palworldReachable: state.palworldReachable,
    updatedAt: state.updatedAt,
  }))

  app.get('/api/server', async () => ({
    reachable: state.palworldReachable,
    error: state.error,
    info: state.info,
    metrics: state.metrics,
    ini: state.iniSummary
      ? {
          serverName: state.iniSummary.serverName,
          maxPlayers: state.iniSummary.maxPlayers,
        }
      : null,
    ts: state.updatedAt,
  }))

  app.get('/api/players', async () => ({
    players: state.players,
    ts: state.updatedAt,
  }))

  app.get('/api/settings', async () => ({
    api: state.settings,
    ini: state.iniSummary,
    ts: state.updatedAt,
  }))

  app.get('/api/events', async (request, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.raw.write(': connected\n\n')

    const remove = addSseClient(reply)
    const snap = snapshotForClient()
    reply.raw.write(`event: status\ndata: ${JSON.stringify(snap.status)}\n\n`)
    reply.raw.write(`event: server\ndata: ${JSON.stringify(snap.server)}\n\n`)
    reply.raw.write(`event: players\ndata: ${JSON.stringify(snap.players)}\n\n`)
    reply.raw.write(`event: settings\ndata: ${JSON.stringify(snap.settings)}\n\n`)
    for (const entry of snap.logs) {
      reply.raw.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`)
    }

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n')
      } catch {
        clearInterval(heartbeat)
      }
    }, 15000)

    request.raw.on('close', () => {
      clearInterval(heartbeat)
      remove()
    })
  })

  app.post('/api/announce', async (request, reply) => {
    if (!requireToken(request, reply)) return
    const message = request.body?.message
    if (!message || typeof message !== 'string' || !message.trim()) {
      return reply.code(400).send({ error: 'message is required' })
    }
    try {
      await palworld.announce(message.trim())
      return { ok: true }
    } catch (err) {
      return reply.code(err.status || 502).send({ error: err.message })
    }
  })

  app.post('/api/save', async (request, reply) => {
    if (!requireToken(request, reply)) return
    try {
      await palworld.save()
      broadcast('status', {
        palworldReachable: state.palworldReachable,
        error: state.error,
        notice: 'World save requested',
      })
      return { ok: true }
    } catch (err) {
      return reply.code(err.status || 502).send({ error: err.message })
    }
  })
}
