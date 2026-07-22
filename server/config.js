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
  // Writable directory for dashboard-owned state (e.g. the local banlist).
  // Mounted as a persistent volume in production; falls back gracefully to
  // in-memory when unwritable (e.g. local dev without the volume).
  dataDir: process.env.DASHBOARD_DATA_DIR || '/data',
  // Seconds to warn players (announce + save) before a restart takes the
  // container down.
  restartGraceSeconds: intEnv('RESTART_GRACE_SECONDS', 10),
  palworld: {
    apiUrl: (process.env.PALWORLD_API_URL || 'http://127.0.0.1:8212').replace(/\/$/, ''),
    user: process.env.PALWORLD_API_USER || 'admin',
    password: process.env.PALWORLD_API_PASSWORD || '',
    logPath: process.env.PALWORLD_LOG_PATH || '',
    configPath: process.env.PALWORLD_CONFIG_PATH || '',
    // Name/ID of the Palworld game-server container. When set, logs are
    // streamed from its stdout via the Docker socket instead of a log file.
    container: process.env.PALWORLD_CONTAINER || '',
    // World save folder (contains Level.sav + Players/). Mount :ro in Docker.
    // Snapshots are copied into DASHBOARD_DATA_DIR/save-snapshots/ before parse.
    savePath: process.env.PALWORLD_SAVE_PATH || '',
    // Python used to run parser/extract_bases.py. Empty → local .venv-save-tools
    // or python3 on PATH.
    parserPython: process.env.PALWORLD_PARSER_PYTHON || '',
    parserTimeoutMs: intEnv('PALWORLD_PARSER_TIMEOUT_MS', 120_000),
    snapshotKeep: intEnv('PALWORLD_SNAPSHOT_KEEP', 5),
  },
  // 'docker' | 'file' | 'auto' — auto picks docker when a container is set.
  logSource: (process.env.LOG_SOURCE || 'auto').toLowerCase(),
  // Regex; log lines matching it are dropped before buffering/broadcast.
  // Used to filter out the dashboard's own REST API poll traffic.
  logExclude: process.env.LOG_EXCLUDE || '',
  isProd: process.env.NODE_ENV === 'production',
}
