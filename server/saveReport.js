import { spawn } from 'node:child_process'
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { broadcast } from './state.js'
import { palworld } from './palworld.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EXTRACT_SCRIPT = path.join(__dirname, '..', 'parser', 'extract_bases.py')

let reportState = emptyState()
let parseInFlight = null

function emptyState() {
  return {
    status: 'idle', // idle | snapshotting | parsing | ready | error | unavailable
    updatedAt: null,
    snapshotId: null,
    snapshotPath: null,
    trigger: null,
    error: null,
    report: null,
  }
}

export function getSaveReport() {
  return reportState
}

function setState(patch) {
  reportState = { ...reportState, ...patch, updatedAt: Date.now() }
  broadcast('bases', snapshotForClient())
  return reportState
}

export function snapshotForClient() {
  const r = reportState.report
  return {
    status: reportState.status,
    updatedAt: reportState.updatedAt,
    snapshotId: reportState.snapshotId,
    trigger: reportState.trigger,
    error: reportState.error,
    stats: r?.stats ?? null,
    players: r?.players ?? [],
    bases: r?.bases ?? [],
    world: r?.world ?? null,
    source: r?.source ?? null,
  }
}

function snapshotsRoot() {
  return path.join(config.dataDir, 'save-snapshots')
}

function reportCachePath() {
  return path.join(config.dataDir, 'bases-report.json')
}

async function pathExists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve Level.sav under PALWORLD_SAVE_PATH.
 * Accepts either the world folder (contains Level.sav) or SaveGames/<worldid>.
 */
export async function resolveLevelSav(savePath = config.palworld.savePath) {
  if (!savePath) return null
  const direct = path.join(savePath, 'Level.sav')
  if (await pathExists(direct)) return { worldDir: savePath, levelSav: direct }
  if (path.basename(savePath) === 'Level.sav' && (await pathExists(savePath))) {
    return { worldDir: path.dirname(savePath), levelSav: savePath }
  }
  try {
    const entries = await readdir(savePath, { withFileTypes: true })
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      const candidate = path.join(savePath, ent.name, 'Level.sav')
      if (await pathExists(candidate)) {
        return { worldDir: path.join(savePath, ent.name), levelSav: candidate }
      }
    }
  } catch {
    // ignore
  }
  return null
}

async function copyDirFiltered(srcDir, destDir) {
  await mkdir(destDir, { recursive: true })
  const entries = await readdir(srcDir, { withFileTypes: true })
  for (const ent of entries) {
    const from = path.join(srcDir, ent.name)
    const to = path.join(destDir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === 'Players') {
        await copyDirFiltered(from, to)
      }
      continue
    }
    if (!ent.isFile()) continue
    if (ent.name.endsWith('.sav')) {
      await copyFile(from, to)
    }
  }
}

/**
 * Copy the live world folder (Level.sav + LevelMeta.sav + Players/*.sav) into
 * destDir. Never mutates the source. Shared by snapshots, migration backups,
 * and mutable working copies (see server/saveMigration.js).
 */
export async function copyWorldFolder(destDir) {
  const resolved = await resolveLevelSav()
  if (!resolved) {
    const err = new Error(
      config.palworld.savePath
        ? `No Level.sav found under PALWORLD_SAVE_PATH (${config.palworld.savePath})`
        : 'PALWORLD_SAVE_PATH is not configured',
    )
    err.code = 'save_path_unavailable'
    throw err
  }
  await mkdir(destDir, { recursive: true })
  await copyFile(resolved.levelSav, path.join(destDir, 'Level.sav'))
  const meta = path.join(resolved.worldDir, 'LevelMeta.sav')
  if (await pathExists(meta)) {
    await copyFile(meta, path.join(destDir, 'LevelMeta.sav'))
  }
  const playersSrc = path.join(resolved.worldDir, 'Players')
  if (await pathExists(playersSrc)) {
    await copyDirFiltered(playersSrc, path.join(destDir, 'Players'))
  }
  return { worldDir: resolved.worldDir, destDir, levelSav: path.join(destDir, 'Level.sav') }
}

/**
 * Copy the live world folder into a timestamped snapshot directory.
 * Never mutates the source.
 */
export async function takeSaveSnapshot({ trigger = 'manual' } = {}) {
  void trigger
  const snapshotId = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(snapshotsRoot(), snapshotId)
  const { levelSav } = await copyWorldFolder(dest)
  await pruneSnapshots(config.palworld.snapshotKeep).catch((err) => {
    console.warn('[saveReport] prune failed:', err.message)
  })
  return { snapshotId, snapshotPath: dest, levelSav }
}

async function pruneSnapshots(keep) {
  const root = snapshotsRoot()
  if (!(await pathExists(root))) return
  const entries = await readdir(root, { withFileTypes: true })
  const dirs = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const full = path.join(root, ent.name)
    const st = await stat(full)
    dirs.push({ full, mtime: st.mtimeMs })
  }
  dirs.sort((a, b) => b.mtime - a.mtime)
  for (const dir of dirs.slice(Math.max(0, keep))) {
    await rm(dir.full, { recursive: true, force: true })
  }
}

export function resolvePythonBin() {
  if (config.palworld.parserPython) return config.palworld.parserPython
  return path.join(__dirname, '..', '.venv-save-tools', 'bin', 'python')
}

/**
 * Spawn a parser script and parse its single-line JSON stdout. Rejects on
 * timeout, non-JSON output, or a `{ ok: false }` payload (surfacing the
 * script's own error code/message). Shared by the bases report and the
 * migration tooling (roundtrip_test.py / migrate_uid.py).
 */
export async function runParserJson(
  scriptPath,
  args = [],
  { timeoutMs = config.palworld.parserTimeoutMs } = {},
) {
  const preferred = resolvePythonBin()
  const bin = (await pathExists(preferred)) ? preferred : 'python3'

  return new Promise((resolve, reject) => {
    const child = spawn(bin, [scriptPath, ...args], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      const err = new Error(`Parser timed out after ${timeoutMs}ms`)
      err.code = 'parser_timeout'
      reject(err)
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 50_000) stderr = stderr.slice(-50_000)
    })
    child.on('error', (err) => {
      clearTimeout(timeout)
      err.code = err.code || 'parser_spawn_failed'
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      const trimmed = stdout.trim()
      let parsed = null
      try {
        parsed = trimmed ? JSON.parse(trimmed) : null
      } catch {
        const err = new Error(
          `Parser returned non-JSON (exit ${code}): ${trimmed.slice(0, 200) || stderr.slice(0, 200)}`,
        )
        err.code = 'parser_bad_output'
        err.stderr = stderr
        reject(err)
        return
      }
      if (!parsed?.ok) {
        const err = new Error(parsed?.error?.message || `Parser failed (exit ${code})`)
        err.code = parsed?.error?.code || 'parser_failed'
        err.details = parsed?.error?.details || stderr
        reject(err)
        return
      }
      resolve(parsed)
    })
  })
}

async function runExtract(levelSav) {
  return runParserJson(EXTRACT_SCRIPT, [levelSav])
}

async function persistReportCache(state) {
  try {
    await mkdir(config.dataDir, { recursive: true })
    const tmp = `${reportCachePath()}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
    await rename(tmp, reportCachePath())
  } catch (err) {
    console.warn('[saveReport] cache write failed:', err.message)
  }
}

export async function loadCachedReport() {
  try {
    const raw = await readFile(reportCachePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      reportState = {
        ...emptyState(),
        ...parsed,
        status:
          parsed.status === 'ready' || parsed.status === 'error'
            ? parsed.status
            : parsed.report
              ? 'ready'
              : 'idle',
      }
      return reportState
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[saveReport] cache load failed:', err.message)
    }
  }
  return reportState
}

/**
 * Snapshot (optional) + parse. Concurrent calls share one in-flight promise.
 *
 * Safe while the game server is running: best-effort REST save() first, then
 * copy Level.sav, then parse the copy (never the live file).
 */
export async function snapshotAndParse({
  trigger = 'manual',
  skipSnapshot = false,
  levelSav = null,
  saveBeforeSnapshot = true,
} = {}) {
  if (parseInFlight) return parseInFlight

  parseInFlight = (async () => {
    try {
      let snap = null
      if (skipSnapshot && levelSav) {
        snap = {
          snapshotId: reportState.snapshotId || 'inline',
          snapshotPath: path.dirname(levelSav),
          levelSav,
        }
      } else {
        setState({
          status: 'snapshotting',
          trigger,
          error: null,
        })

        if (saveBeforeSnapshot) {
          try {
            await palworld.save()
            // Brief settle so the dedicated server can flush Level.sav to disk
            // before we copy. Best-effort; copy still proceeds if save fails.
            await new Promise((resolve) => setTimeout(resolve, 1500))
          } catch (err) {
            console.warn(
              '[saveReport] pre-snapshot save failed (continuing with copy):',
              err.message,
            )
          }
        }

        snap = await takeSaveSnapshot({ trigger })
      }

      setState({
        status: 'parsing',
        trigger,
        snapshotId: snap.snapshotId,
        snapshotPath: snap.snapshotPath,
        error: null,
      })

      const report = await runExtract(snap.levelSav)
      const next = setState({
        status: 'ready',
        trigger,
        snapshotId: snap.snapshotId,
        snapshotPath: snap.snapshotPath,
        error: null,
        report,
      })
      await persistReportCache(next)
      return next
    } catch (err) {
      const next = setState({
        status: 'error',
        trigger,
        error: {
          code: err.code || 'unknown',
          message: err.message,
          details: err.details || null,
        },
        report: reportState.report,
      })
      await persistReportCache(next)
      throw err
    } finally {
      parseInFlight = null
    }
  })()

  return parseInFlight
}

/** Fire-and-forget for autostop/stop — never blocks container stop. */
export function queueSnapshotAndParse(opts) {
  snapshotAndParse(opts).catch((err) => {
    console.warn('[saveReport] snapshot/parse failed:', err.message)
  })
}
