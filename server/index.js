import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { config } from './config.js'
import { registerRoutes } from './routes.js'
import { startPoller, stopPoller } from './poller.js'
import { startLogTail, stopLogTail } from './logTail.js'
import { startDockerLogs, stopDockerLogs } from './dockerLogs.js'

// Choose the log source: docker (stream a container's stdout) or file (tail a
// Pal.log). 'auto' uses docker whenever a container name is configured.
const useDockerLogs =
  config.logSource === 'docker' ||
  (config.logSource === 'auto' && Boolean(config.palworld.container))
const startLogs = useDockerLogs ? startDockerLogs : startLogTail
const stopLogs = useDockerLogs ? stopDockerLogs : stopLogTail

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const clientDist = path.join(__dirname, '..', 'client', 'dist')

const app = Fastify({
  logger: true,
})

await registerRoutes(app)

if (config.isProd) {
  await app.register(fastifyStatic, {
    root: clientDist,
    wildcard: false,
  })
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' })
    }
    return reply.sendFile('index.html')
  })
} else {
  app.get('/', async (_request, reply) => {
    reply.type('text/html').send(
      `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
        <h1>Palworld Dashboard API</h1>
        <p>Dev mode: open the Vite client on <a href="http://127.0.0.1:5173">http://127.0.0.1:5173</a>.</p>
        <p>API health: <a href="/api/health">/api/health</a></p>
      </body></html>`,
    )
  })
}

startPoller()
app.log.info(
  {
    source: useDockerLogs
      ? `docker:${config.palworld.container || '(unset)'}`
      : `file:${config.palworld.logPath || '(unset)'}`,
    logExclude: config.logExclude || '(none)',
  },
  'log streaming config',
)
startLogs().catch((err) => app.log.warn({ err }, 'log streaming failed to start'))

const shutdown = async () => {
  stopPoller()
  stopLogs()
  await app.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

try {
  await app.listen({ port: config.port, host: '0.0.0.0' })
  app.log.info(`Dashboard listening on :${config.port}`)
  app.log.info(`Palworld API: ${config.palworld.apiUrl}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
