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
 * Copy the live world folder into a timestamped snapshot directory.
 * Never mutates the source.
 */
export async function takeSaveSnapshot({ trigger = 'manual' } = {}) {
  void trigger
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

  const snapshotId = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(snapshotsRoot(), snapshotId)
  await mkdir(dest, { recursive: true })

  await copyFile(resolved.levelSav, path.join(dest, 'Level.sav'))
  const meta = path.join(resolved.worldDir, 'LevelMeta.sav')
  if (await pathExists(meta)) {
    await copyFile(meta, path.join(dest, 'LevelMeta.sav'))
  }
  const playersSrc = path.join(resolved.worldDir, 'Players')
  if (await pathExists(playersSrc)) {
    await copyDirFiltered(playersSrc, path.join(dest, 'Players'))
  }

  await pruneSnapshots(config.palworld.snapshotKeep).catch((err) => {
    console.warn('[saveReport] prune failed:', err.message)
  })

  return { snapshotId, snapshotPath: dest, levelSav: path.join(dest, 'Level.sav') }
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

function resolvePythonBin() {
  if (config.palworld.parserPython) return config.palworld.parserPython
  return path.join(__dirname, '..', '.venv-save-tools', 'bin', 'python')
}

async function runExtract(levelSav) {
  const preferred = resolvePythonBin()
  const bin = (await pathExists(preferred)) ? preferred : 'python3'

  return new Promise((resolve, reject) => {
    const child = spawn(bin, [EXTRACT_SCRIPT, levelSav], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      const err = new Error(`Parser timed out after ${config.palworld.parserTimeoutMs}ms`)
      err.code = 'parser_timeout'
      reject(err)
    }, config.palworld.parserTimeoutMs)

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
 */
export async function snapshotAndParse({
  trigger = 'manual',
  skipSnapshot = false,
  levelSav = null,
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
