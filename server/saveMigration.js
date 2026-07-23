import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { broadcast } from './state.js'
import { getContainerState } from './dockerControl.js'
import { palworld } from './palworld.js'
import { copyWorldFolder, resolveLevelSav, runParserJson } from './saveReport.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROUNDTRIP_SCRIPT = path.join(__dirname, '..', 'parser', 'roundtrip_test.py')
const MIGRATE_SCRIPT = path.join(__dirname, '..', 'parser', 'migrate_uid.py')
const EXTRACT_SCRIPT = path.join(__dirname, '..', 'parser', 'extract_bases.py')

// ---------------------------------------------------------------------------
// State machine (mirrors saveReport.js). One migration op runs at a time.
// ---------------------------------------------------------------------------

let migrationState = emptyState()
let inFlight = null

function emptyState() {
  return {
    status: 'idle', // idle | busy | ready | error
    phase: null, // selftest | preview | apply | rollback | backup
    updatedAt: null,
    selftest: null, // roundtrip_test.py result
    preview: null, // { sourceUid, targetUid, ...migrate --dry-run result }
    lastApply: null, // { backupId, sourceUid, targetUid, promotedAt }
    lastRestore: null, // { backupId, safetyBackupId, restoredAt }
    lastBackup: null, // { backupId, createdAt, trigger }
    error: null,
  }
}

export function getMigrationState() {
  return migrationState
}

export function snapshotForClient() {
  return { ...migrationState }
}

function setState(patch) {
  migrationState = { ...migrationState, ...patch, updatedAt: Date.now() }
  broadcast('migration', snapshotForClient())
  return migrationState
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function pathExists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

function workRoot() {
  return path.join(config.dataDir, 'migration-work')
}

function backupsRoot() {
  return path.join(config.dataDir, 'migration-backups')
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

// ---------------------------------------------------------------------------
// Backups — full world-folder copies under migration-backups/<id>/, each with a
// backup.json manifest. Disk is the source of truth: the list survives dashboard
// restarts, so a restore is always reachable even long after a migration.
// ---------------------------------------------------------------------------

async function writeBackupMeta(dir, meta) {
  try {
    await writeFile(path.join(dir, 'backup.json'), JSON.stringify(meta, null, 2), 'utf8')
  } catch (err) {
    console.warn('[saveMigration] backup manifest write failed:', err.message)
  }
}

async function readBackupMeta(dir) {
  try {
    return JSON.parse(await readFile(path.join(dir, 'backup.json'), 'utf8'))
  } catch {
    return null
  }
}

/** Copy the live world folder into a new, un-pruned backup + write its manifest. */
export async function createBackup({ trigger = 'manual', sourceUid = null, targetUid = null } = {}) {
  const backupId = stamp()
  const dir = path.join(backupsRoot(), backupId)
  const { worldDir } = await copyWorldFolder(dir)
  const meta = { backupId, createdAt: Date.now(), trigger, sourceUid, targetUid, worldDir }
  await writeBackupMeta(dir, meta)
  return meta
}

/** Every backup on disk, newest first (for the restore UI). */
export async function listBackups() {
  const root = backupsRoot()
  if (!(await pathExists(root))) return []
  const out = []
  for (const ent of await readdir(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    const dir = path.join(root, ent.name)
    if (!(await pathExists(path.join(dir, 'Level.sav')))) continue
    let playerFiles = 0
    const playersDir = path.join(dir, 'Players')
    if (await pathExists(playersDir)) {
      playerFiles = (await readdir(playersDir)).filter((f) => f.endsWith('.sav')).length
    }
    const meta = (await readBackupMeta(dir)) || {}
    out.push({
      backupId: ent.name,
      createdAt: meta.createdAt ?? null,
      trigger: meta.trigger ?? null,
      sourceUid: meta.sourceUid ?? null,
      targetUid: meta.targetUid ?? null,
      playerFiles,
    })
  }
  out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || (a.backupId < b.backupId ? 1 : -1))
  return out
}

/** Manual, on-demand backup. Best-effort REST save first if the server is up. */
export async function runBackup() {
  return runOp('backup', async () => {
    try {
      const info = await getContainerState()
      if (info?.running) {
        await palworld.save().catch(() => {})
        // Brief settle so the dedicated server flushes Level.sav before we copy.
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    } catch {
      // fall through — copy the save as-is
    }
    const meta = await createBackup({ trigger: 'manual' })
    return setState({ status: 'ready', phase: 'backup', lastBackup: meta, error: null })
  })
}

function errShape(err) {
  return { code: err.code || 'unknown', message: err.message, details: err.details || null }
}

function fail(message, code, status) {
  const err = new Error(message)
  err.code = code
  if (status) err.status = status
  return err
}

function assertBusyFree() {
  if (inFlight) throw fail('A migration operation is already in progress', 'busy', 409)
}

function validateUids(sourceUid, targetUid) {
  if (typeof sourceUid !== 'string' || !sourceUid.trim()) {
    throw fail('sourceUid is required', 'bad_request', 400)
  }
  if (typeof targetUid !== 'string' || !targetUid.trim()) {
    throw fail('targetUid is required', 'bad_request', 400)
  }
  if (normUid(sourceUid) === normUid(targetUid)) {
    throw fail('sourceUid and targetUid must differ', 'bad_request', 400)
  }
}

function normUid(u) {
  return String(u || '')
    .replace(/-/g, '')
    .toLowerCase()
}

/**
 * The single authoritative "is the game stopped?" gate. Queries the Docker
 * engine directly (State.Running) — never a cached value.
 */
async function assertContainerStopped() {
  const info = await getContainerState()
  if (!info) {
    throw fail(
      'PALWORLD_CONTAINER is not set — cannot verify the game server is stopped',
      'container_not_configured',
      409,
    )
  }
  if (info.running !== false) {
    throw fail(
      `Game container is ${info.status || 'running'} — stop the server before migrating`,
      'server_running',
      409,
    )
  }
}

/** Copy only the live Level.sav into destDir (for the read-only self-test). */
async function copyLevelOnly(destDir) {
  const resolved = await resolveLevelSav()
  if (!resolved) {
    throw fail(
      config.palworld.savePath
        ? `No Level.sav found under PALWORLD_SAVE_PATH (${config.palworld.savePath})`
        : 'PALWORLD_SAVE_PATH is not configured',
      'save_path_unavailable',
      503,
    )
  }
  await mkdir(destDir, { recursive: true })
  const dest = path.join(destDir, 'Level.sav')
  await copyFile(resolved.levelSav, dest)
  return { levelSav: dest }
}

/**
 * Post-migration guard: the migrated Level.sav must re-parse AND the target UID
 * must now appear as a player. If either fails we never promote.
 */
function assertTargetPresent(validation, targetUid) {
  const target = normUid(targetUid)
  const players = Array.isArray(validation?.players) ? validation.players : []
  const present = players.some((p) => normUid(p.playerUid) === target)
  if (!present) {
    const err = fail(
      'Post-migration validation failed: target UID is not a player in the migrated save',
      'validation_failed',
    )
    err.details = JSON.stringify({ targetUid, foundPlayers: players.map((p) => p.playerUid) })
    throw err
  }
}

async function runOp(phase, fn) {
  assertBusyFree()
  inFlight = (async () => {
    setState({ status: 'busy', phase, error: null })
    try {
      return await fn()
    } catch (err) {
      setState({ status: 'error', phase, error: errShape(err) })
      throw err
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Stage 0 gate. Copy the live Level.sav and prove load -> re-serialize ->
 * recompress round-trips byte-identical. Read-only; safe while running.
 */
export async function runSelftest({ mode = 'migrate' } = {}) {
  return runOp('selftest', async () => {
    const dir = path.join(workRoot(), `selftest-${stamp()}`)
    try {
      const { levelSav } = await copyLevelOnly(dir)
      const result = await runParserJson(ROUNDTRIP_SCRIPT, [levelSav, '--set', mode])
      return setState({ status: 'ready', phase: 'selftest', selftest: result, error: null })
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
}

/**
 * Dry-run the migration on a throwaway working copy and return the diff.
 * Never touches the live save; safe while the server is running.
 */
export async function runPreview({ sourceUid, targetUid }) {
  validateUids(sourceUid, targetUid)
  return runOp('preview', async () => {
    const dir = path.join(workRoot(), `preview-${stamp()}`)
    try {
      const copy = await copyWorldFolder(dir)
      const result = await runParserJson(MIGRATE_SCRIPT, [
        copy.levelSav,
        '--source',
        sourceUid,
        '--target',
        targetUid,
        '--players-dir',
        path.join(dir, 'Players'),
        '--dry-run',
      ])
      return setState({
        status: 'ready',
        phase: 'preview',
        preview: { sourceUid, targetUid, ...result },
        error: null,
      })
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
}

/**
 * The real migration. Gated on a stopped server. Backup -> migrate a working
 * copy -> re-parse to validate -> promote. The live save is written only in the
 * final promote step, after validation; on any failure it is left untouched.
 */
export async function applyMigration({ sourceUid, targetUid }) {
  validateUids(sourceUid, targetUid)
  return runOp('apply', async () => {
    await assertContainerStopped()

    // 1. Pristine, un-pruned backup (with manifest) for rollback.
    const backup = await createBackup({ trigger: 'pre-migration', sourceUid, targetUid })
    const backupId = backup.backupId

    // 2. Mutable working copy from the live save.
    const dir = path.join(workRoot(), `apply-${stamp()}`)
    try {
      const copy = await copyWorldFolder(dir)

      // 3. Migrate the working copy in place.
      const migrate = await runParserJson(MIGRATE_SCRIPT, [
        copy.levelSav,
        '--source',
        sourceUid,
        '--target',
        targetUid,
        '--players-dir',
        path.join(dir, 'Players'),
      ])

      // 4. Validate: the migrated Level.sav must load and show the target UID.
      const validation = await runParserJson(EXTRACT_SCRIPT, [copy.levelSav])
      assertTargetPresent(validation, targetUid)

      // 5. Re-confirm stopped, then promote into the live (:rw) folder.
      await assertContainerStopped()
      const resolved = await resolveLevelSav()
      if (!resolved) throw fail('Live save disappeared before promote', 'save_path_unavailable')
      await promoteWorkingCopy(dir, resolved.worldDir, migrate?.output)

      return setState({
        status: 'ready',
        phase: 'apply',
        preview: null,
        lastApply: { backupId, sourceUid, targetUid, migrate, promotedAt: Date.now() },
        error: null,
      })
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
}

/**
 * Copy the migrated Level.sav and the new target Players/*.sav over the live
 * folder, and remove the live SOURCE player file. Removing it matters: the
 * migrated character keeps the source InstanceId, so leaving the old source
 * file would leave two live player files claiming the same instance id. The
 * pristine backup restores it verbatim on rollback, so this is safe.
 */
async function promoteWorkingCopy(workDir, liveWorldDir, output) {
  const targetPlayersFile = output?.playersFile
  const removedPlayersFile = output?.removedPlayersFile
  const livePlayers = path.join(liveWorldDir, 'Players')

  await copyFile(path.join(workDir, 'Level.sav'), path.join(liveWorldDir, 'Level.sav'))

  if (targetPlayersFile) {
    const src = path.join(workDir, 'Players', targetPlayersFile)
    if (await pathExists(src)) {
      await mkdir(livePlayers, { recursive: true })
      await copyFile(src, path.join(livePlayers, targetPlayersFile))
    }
  }
  if (removedPlayersFile) {
    await rm(path.join(livePlayers, removedPlayersFile), { force: true }).catch(() => {})
  }
}

/** Restore a pristine backup over the live folder. Gated on a stopped server. */
export async function rollbackMigration({ backupId }) {
  if (typeof backupId !== 'string' || !backupId.trim()) {
    throw fail('backupId is required', 'bad_request', 400)
  }
  return runOp('rollback', async () => {
    await assertContainerStopped()
    const backupDir = path.join(backupsRoot(), backupId)
    if (!(await pathExists(path.join(backupDir, 'Level.sav')))) {
      throw fail(`Backup ${backupId} not found`, 'not_found', 404)
    }
    const resolved = await resolveLevelSav()
    if (!resolved) throw fail('Live save is unavailable', 'save_path_unavailable', 503)

    // Safety net: snapshot the CURRENT live save before overwriting it, so a
    // restore is itself reversible (recover from restoring the wrong backup).
    const safety = await createBackup({ trigger: 'pre-restore' })

    await copyFile(path.join(backupDir, 'Level.sav'), path.join(resolved.worldDir, 'Level.sav'))
    const levelMeta = path.join(backupDir, 'LevelMeta.sav')
    if (await pathExists(levelMeta)) {
      await copyFile(levelMeta, path.join(resolved.worldDir, 'LevelMeta.sav'))
    }
    const backupPlayers = path.join(backupDir, 'Players')
    if (await pathExists(backupPlayers)) {
      const livePlayers = path.join(resolved.worldDir, 'Players')
      await mkdir(livePlayers, { recursive: true })
      for (const ent of await readdir(backupPlayers, { withFileTypes: true })) {
        if (ent.isFile() && ent.name.endsWith('.sav')) {
          await copyFile(path.join(backupPlayers, ent.name), path.join(livePlayers, ent.name))
        }
      }
    }
    return setState({
      status: 'ready',
      phase: 'rollback',
      lastRestore: { backupId, safetyBackupId: safety.backupId, restoredAt: Date.now() },
      error: null,
    })
  })
}
