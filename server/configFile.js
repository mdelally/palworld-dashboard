import { readFile, writeFile, stat, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'

// Read / write / back up PalWorldSettings.ini for the in-dashboard editor.
//
// The ini is bind-mounted into the container as a SINGLE file (see the compose
// files). Two consequences shape this module:
//   1. We must write the file *in place* (writeFile truncates + writes, keeping
//      the same inode). Never rename/replace it, or the bind mount detaches.
//   2. There is no writable host directory alongside the file — its siblings
//      live in the dashboard's own /data volume. So timestamped backups are
//      kept in `${dataDir}/config-backups/` rather than next to the ini. They
//      persist across restarts/image updates and are restorable from the UI.

const BACKUP_PREFIX = 'PalWorldSettings.ini.bak.'

function configPath() {
  return config.palworld.configPath
}

function backupsDir() {
  return path.join(config.dataDir, 'config-backups')
}

function httpError(message, status) {
  const err = new Error(message)
  err.status = status
  return err
}

/**
 * Lenient guard against writing corrupt content. Not a full ini schema check —
 * just enough to refuse an empty/truncated file that would brick the server.
 * Returns an error string, or null when the content looks safe to write.
 */
export function validateIniContent(text) {
  if (typeof text !== 'string') return 'content must be a string'
  if (text.trim().length === 0) return 'refusing to write an empty config'

  const marker = 'OptionSettings=('
  const idx = text.indexOf(marker)
  if (idx !== -1) {
    // The Palworld settings live in one parenthesised block. A truncated save
    // usually loses the closing paren — verify the block is balanced/closed.
    let depth = 0
    let closed = false
    for (let i = idx + marker.length - 1; i < text.length; i++) {
      const c = text[i]
      if (c === '(') depth++
      else if (c === ')') {
        depth--
        if (depth === 0) {
          closed = true
          break
        }
        if (depth < 0) return 'unbalanced parentheses in OptionSettings'
      }
    }
    if (!closed) return 'OptionSettings block is not closed — refusing to write'
  } else if (!/\[[^\]]+\]/.test(text)) {
    // No settings block and no [Section] header — this is not an ini file.
    return 'content does not look like an ini file (no section header)'
  }
  return null
}

export async function readConfigFile() {
  const p = configPath()
  if (!p) throw httpError('No config path configured (set PALWORLD_CONFIG_PATH)', 500)
  try {
    const [content, s] = await Promise.all([readFile(p, 'utf8'), stat(p)])
    return { path: p, content, mtime: s.mtimeMs }
  } catch (err) {
    if (err.code === 'ENOENT') throw httpError(`Config file not found at ${p}`, 404)
    throw err
  }
}

/**
 * Snapshot the current file into the backups dir before it's overwritten.
 * Returns the backup filename, or null when there is no current file to snapshot.
 */
async function backupCurrent() {
  let current
  try {
    current = await readFile(configPath(), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  const dir = backupsDir()
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const name = `${BACKUP_PREFIX}${stamp}`
  await writeFile(path.join(dir, name), current, 'utf8')
  return name
}

export async function writeConfigFile(newContent) {
  const p = configPath()
  if (!p) throw httpError('No config path configured (set PALWORLD_CONFIG_PATH)', 500)

  const problem = validateIniContent(newContent)
  if (problem) throw httpError(problem, 400)

  // Back up the current file first. If we can't establish a recovery point,
  // abort rather than overwrite blind.
  let backup
  try {
    backup = await backupCurrent()
  } catch (err) {
    throw httpError(`Failed to write backup, aborting save: ${err.message}`, 500)
  }

  // Write in place — see the module header on why we never rename.
  await writeFile(p, newContent, 'utf8')
  const s = await stat(p)
  return { backup, mtime: s.mtimeMs }
}

export async function listConfigBackups() {
  let names
  try {
    names = await readdir(backupsDir())
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  const out = []
  for (const name of names) {
    if (!name.startsWith(BACKUP_PREFIX)) continue
    try {
      const s = await stat(path.join(backupsDir(), name))
      out.push({ name, size: s.size, mtime: s.mtimeMs })
    } catch {
      // skip entries we can't stat
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

export async function restoreConfigBackup(name) {
  // Only ever touch a bare backup filename we manage — block path traversal.
  const safe = path.basename(name || '')
  if (!safe.startsWith(BACKUP_PREFIX)) throw httpError('invalid backup name', 400)

  let content
  try {
    content = await readFile(path.join(backupsDir(), safe), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') throw httpError('backup not found', 404)
    throw err
  }

  const problem = validateIniContent(content)
  if (problem) throw httpError(`backup is invalid (${problem}) — not restoring`, 422)

  // writeConfigFile snapshots the CURRENT file before overwriting, so a restore
  // is itself reversible.
  const res = await writeConfigFile(content)
  return { restored: safe, backup: res.backup, mtime: res.mtime }
}
