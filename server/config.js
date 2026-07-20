function intEnv(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}

export const config = {
  port: intEnv('DASHBOARD_PORT', 8787),
  pollIntervalMs: intEnv('POLL_INTERVAL_MS', 2000),
  logBufferLines: intEnv('LOG_BUFFER_LINES', 500),
  dashboardToken: process.env.DASHBOARD_TOKEN || '',
  dockerSocket: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
  palworld: {
    apiUrl: (process.env.PALWORLD_API_URL || 'http://127.0.0.1:8212').replace(/\/$/, ''),
    user: process.env.PALWORLD_API_USER || 'admin',
    password: process.env.PALWORLD_API_PASSWORD || '',
    logPath: process.env.PALWORLD_LOG_PATH || '',
    configPath: process.env.PALWORLD_CONFIG_PATH || '',
    // Name/ID of the Palworld game-server container. When set, logs are
    // streamed from its stdout via the Docker socket instead of a log file.
    container: process.env.PALWORLD_CONTAINER || '',
  },
  // 'docker' | 'file' | 'auto' — auto picks docker when a container is set.
  logSource: (process.env.LOG_SOURCE || 'auto').toLowerCase(),
  // Regex; log lines matching it are dropped before buffering/broadcast.
  // Used to filter out the dashboard's own REST API poll traffic.
  logExclude: process.env.LOG_EXCLUDE || '',
  isProd: process.env.NODE_ENV === 'production',
}
