import { config } from './config.js'
import { palworld } from './palworld.js'
import { state, addSseClient, snapshotForClient, broadcast } from './state.js'
import { listBans, addBan, removeBan } from './banlist.js'
import { restartContainer, startContainer, stopContainer } from './dockerControl.js'
import {
  readConfigFile,
  writeConfigFile,
  listConfigBackups,
  restoreConfigBackup,
} from './configFile.js'
import { refreshIni } from './poller.js'
import {
  snapshot as autostopSnapshot,
  updateAutostopSettings,
  cancelAutostop,
  refreshContainerState,
  ALLOWED_DELAY_MINUTES,
} from './autostop.js'
import {
  snapshotForClient as basesSnapshot,
  snapshotAndParse,
  queueSnapshotAndParse,
  resolveLevelSav,
} from './saveReport.js'
import {
  snapshotForClient as migrationSnapshot,
  runSelftest,
  runPreview,
  applyMigration,
  rollbackMigration,
  runBackup,
  listBackups,
} from './saveMigration.js'

function validUserId(value) {
  return typeof value === 'string' && value.trim().length > 0
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
    reply.raw.write(`event: bans\ndata: ${JSON.stringify(snap.bans)}\n\n`)
    reply.raw.write(`event: autostop\ndata: ${JSON.stringify(snap.autostop)}\n\n`)
    reply.raw.write(`event: bases\ndata: ${JSON.stringify(snap.bases)}\n\n`)
    reply.raw.write(`event: migration\ndata: ${JSON.stringify(migrationSnapshot())}\n\n`)
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

  app.get('/api/bans', async () => ({ bans: listBans() }))

  app.post('/api/kick', async (request, reply) => {
    if (!requireToken(request, reply)) return
    const userid = request.body?.userid
    const message = typeof request.body?.message === 'string' ? request.body.message : ''
    if (!validUserId(userid)) {
      return reply.code(400).send({ error: 'userid is required' })
    }
    try {
      await palworld.kick(userid.trim(), message)
      broadcast('status', {
        palworldReachable: state.palworldReachable,
        error: state.error,
        notice: `Kicked ${message ? `player (${message})` : userid}`,
      })
      return { ok: true }
    } catch (err) {
      return reply.code(err.status || 502).send({ error: err.message })
    }
  })

  app.post('/api/ban', async (request, reply) => {
    if (!requireToken(request, reply)) return
    const userid = request.body?.userid
    const name = typeof request.body?.name === 'string' ? request.body.name : ''
    const message = typeof request.body?.message === 'string' ? request.body.message : ''
    if (!validUserId(userid)) {
      return reply.code(400).send({ error: 'userid is required' })
    }
    try {
      await palworld.ban(userid.trim(), message)
      addBan({ userid: userid.trim(), name, reason: message })
      broadcast('bans', { bans: listBans() })
      broadcast('status', {
        palworldReachable: state.palworldReachable,
        error: state.error,
        notice: `Banned ${name || userid}`,
      })
      return { ok: true }
    } catch (err) {
      return reply.code(err.status || 502).send({ error: err.message })
    }
  })

  app.post('/api/unban', async (request, reply) => {
    if (!requireToken(request, reply)) return
    const userid = request.body?.userid
    if (!validUserId(userid)) {
      return reply.code(400).send({ error: 'userid is required' })
    }
    try {
      await palworld.unban(userid.trim())
      removeBan(userid.trim())
      broadcast('bans', { bans: listBans() })
      broadcast('status', {
        palworldReachable: state.palworldReachable,
        error: state.error,
        notice: `Unbanned ${userid}`,
      })
      return { ok: true }
    } catch (err) {
      return reply.code(err.status || 502).send({ error: err.message })
    }
  })

  // --- Settings .ini editor ------------------------------------------------
  // All four are token-guarded: the raw ini contains the admin/server
  // passwords in plaintext, and PUT/restore are arbitrary config writes.
  // NOTE: like the other mutating routes, these are open when DASHBOARD_TOKEN
  // is unset — set a token before exposing this beyond a trusted LAN.

  app.get('/api/config', async (request, reply) => {
    if (!requireToken(request, reply)) return
    try {
      return await readConfigFile()
    } catch (err) {
      return reply.code(err.status || 500).send({ error: err.message })
    }
  })

  app.put('/api/config', async (request, reply) => {
    if (!requireToken(request, reply)) return
    const content = request.body?.content
    if (typeof content !== 'string') {
      return reply.code(400).send({ error: 'content (string) is required' })
    }
    try {
      const result = await writeConfigFile(content)
      await refreshIni()
      broadcast('status', {
        palworldReachable: state.palworldReachable,
        error: state.error,
        notice: 'Config saved — restart the server to apply',
      })
      return { ok: true, ...result }
    } catch (err) {
      return reply.code(err.status || 500).send({ error: err.message })
    }
  })

  app.get('/api/config/backups', async (request, reply) => {
    if (!requireToken(request, reply)) return
    try {
      return { backups: await listConfigBackups() }
    } catch (err) {
      return reply.code(err.status || 500).send({ error: err.message })
    }
  })

  app.post('/api/config/restore', async (request, reply) => {
    if (!requireToken(request, reply)) return
    const name = request.body?.name
    if (typeof name !== 'string' || !name.trim()) {
      return reply.code(400).send({ error: 'name is required' })
    }
    try {
      const result = await restoreConfigBackup(name.trim())
      await refreshIni()
      broadcast('status', {
        palworldReachable: state.palworldReachable,
        error: state.error,
        notice: 'Config restored — restart the server to apply',
      })
      return { ok: true, ...result }
    } catch (err) {
      return reply.code(err.status || 500).send({ error: err.message })
    }
  })

  app.post('/api/restart', async (request, reply) => {
    if (!requireToken(request, reply)) return
    const grace = Math.max(0, config.restartGraceSeconds)
    try {
      // Warn players, flush the world, then take the container down. The
      // announce/save are best-effort — if the server is already unreachable
      // we still want the restart to proceed.
      if (grace > 0) {
        try {
          await palworld.announce(`Server restarting in ${grace} seconds…`)
          await palworld.save()
        } catch (err) {
          request.log.warn({ err }, 'restart pre-flight announce/save failed')
        }
        broadcast('status', {
          palworldReachable: state.palworldReachable,
          error: state.error,
          notice: `Restart requested — restarting in ${grace}s`,
        })
        await delay(grace * 1000)
      }
      await restartContainer()
      const snap = await refreshContainerState()
      broadcast('autostop', snap)
      broadcast('status', {
        palworldReachable: state.palworldReachable,
        error: state.error,
        notice: 'Container restart issued',
      })
      return { ok: true }
    } catch (err) {
      return reply.code(err.status || 502).send({ error: err.message })
    }
  })

  app.post('/api/start', async (request, reply) => {
    if (!requireToken(request, reply)) return
    try {
      cancelAutostop('Autostop cancelled — manual start')
      await startContainer()
      const snap = await refreshContainerState()
      broadcast('autostop', snap)
      broadcast('status', {
        palworldReachable: state.palworldReachable,
        error: state.error,
        notice: 'Container start issued',
      })
      return { ok: true, autostop: snap }
    } catch (err) {
      return reply.code(err.status || 502).send({ error: err.message })
    }
  })

  app.post('/api/stop', async (request, reply) => {
    if (!requireToken(request, reply)) return
    try {
      cancelAutostop('Autostop cancelled — manual stop')
      try {
        await palworld.save()
      } catch (err) {
        request.log.warn({ err }, 'stop pre-flight save failed')
      }
      // Same snapshot path as autostop: caller already best-effort saved.
      queueSnapshotAndParse({ trigger: 'manual-stop', saveBeforeSnapshot: false })
      await stopContainer({ timeoutSeconds: 30 })
      const snap = await refreshContainerState()
      broadcast('autostop', snap)
      broadcast('status', {
        palworldReachable: state.palworldReachable,
        error: state.error,
        notice: 'Container stop issued',
      })
      return { ok: true, autostop: snap }
    } catch (err) {
      return reply.code(err.status || 502).send({ error: err.message })
    }
  })

  app.get('/api/autostop', async () => autostopSnapshot())

  app.put('/api/autostop', async (request, reply) => {
    if (!requireToken(request, reply)) return
    const { enabled, delayMinutes } = request.body || {}
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled must be a boolean' })
    }
    if (
      delayMinutes !== undefined &&
      !ALLOWED_DELAY_MINUTES.includes(Number(delayMinutes))
    ) {
      return reply.code(400).send({
        error: `delayMinutes must be one of ${ALLOWED_DELAY_MINUTES.join(', ')}`,
      })
    }
    try {
      const snap = await updateAutostopSettings({ enabled, delayMinutes })
      return { ok: true, ...snap }
    } catch (err) {
      return reply.code(err.status || 500).send({ error: err.message })
    }
  })

  app.post('/api/autostop/cancel', async (request, reply) => {
    if (!requireToken(request, reply)) return
    const snap = cancelAutostop('Autostop cancelled manually')
    return { ok: true, ...snap }
  })

  // --- Phase 3: bases / pals report from a save snapshot --------------------
  // Works while the server is running or stopped. Always copies Level.sav
  // (after a best-effort REST save) and parses the copy — never the live file.

  app.get('/api/bases', async () => basesSnapshot())

  app.post('/api/bases/refresh', async (request, reply) => {
    if (!requireToken(request, reply)) return
    const resolved = await resolveLevelSav()
    if (!resolved && !config.palworld.savePath) {
      return reply.code(503).send({
        error: 'PALWORLD_SAVE_PATH is not configured',
        code: 'save_path_unavailable',
      })
    }
    if (!resolved) {
      return reply.code(404).send({
        error: `No Level.sav found under ${config.palworld.savePath}`,
        code: 'save_path_unavailable',
      })
    }
    try {
      const state = await snapshotAndParse({
        trigger: 'manual-refresh',
        saveBeforeSnapshot: true,
      })
      return { ok: true, ...basesSnapshot(), parseStatus: state.status }
    } catch (err) {
      return reply.code(err.code === 'unsupported_save_version' ? 422 : 500).send({
        error: err.message,
        code: err.code || 'parser_failed',
        details: err.details || null,
        ...basesSnapshot(),
      })
    }
  })

  // --- Save migration (Xbox → Steam UID re-point) --------------------------
  // Stop the game container first. Every write is backed up and the migrated
  // save is re-parsed before it's promoted over the live file. All POST
  // actions are token-guarded (they spawn the parser and/or write the save).

  app.get('/api/migration', async () => migrationSnapshot())

  app.get('/api/migration/backups', async () => ({ backups: await listBackups() }))

  app.post('/api/migration/backup', async (request, reply) => {
    if (!requireToken(request, reply)) return
    try {
      const state = await runBackup()
      return {
        ok: true,
        ...migrationSnapshot(),
        backups: await listBackups(),
        migrationStatus: state.status,
      }
    } catch (err) {
      return migrationError(reply, err, 'backup_failed')
    }
  })

  const migrationError = (reply, err, fallbackCode) =>
    reply.code(err.status || 500).send({
      error: err.message,
      code: err.code || fallbackCode,
      details: err.details || null,
      ...migrationSnapshot(),
    })

  app.post('/api/migration/selftest', async (request, reply) => {
    if (!requireToken(request, reply)) return
    const mode = request.body?.mode === 'full' ? 'full' : 'migrate'
    try {
      const state = await runSelftest({ mode })
      return { ok: true, ...migrationSnapshot(), migrationStatus: state.status }
    } catch (err) {
      return migrationError(reply, err, 'selftest_failed')
    }
  })

  app.post('/api/migration/preview', async (request, reply) => {
    if (!requireToken(request, reply)) return
    const { sourceUid, targetUid } = request.body || {}
    try {
      const state = await runPreview({ sourceUid, targetUid })
      return { ok: true, ...migrationSnapshot(), migrationStatus: state.status }
    } catch (err) {
      return migrationError(reply, err, 'preview_failed')
    }
  })

  app.post('/api/migration/apply', async (request, reply) => {
    if (!requireToken(request, reply)) return
    const { sourceUid, targetUid, confirm } = request.body || {}
    if (confirm !== true) {
      return reply
        .code(400)
        .send({ error: 'confirm: true is required to apply a migration', code: 'confirm_required' })
    }
    try {
      const state = await applyMigration({ sourceUid, targetUid })
      return {
        ok: true,
        ...migrationSnapshot(),
        backups: await listBackups(),
        migrationStatus: state.status,
      }
    } catch (err) {
      return migrationError(reply, err, 'apply_failed')
    }
  })

  app.post('/api/migration/rollback', async (request, reply) => {
    if (!requireToken(request, reply)) return
    const { backupId } = request.body || {}
    try {
      const state = await rollbackMigration({ backupId })
      return {
        ok: true,
        ...migrationSnapshot(),
        backups: await listBackups(),
        migrationStatus: state.status,
      }
    } catch (err) {
      return migrationError(reply, err, 'rollback_failed')
    }
  })
}
