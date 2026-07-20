import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

// Palworld's REST API can ban/unban but has no "list bans" endpoint, so the
// dashboard keeps its own record purely so the UI has something to target for
// unban. The in-game ban is authoritative; this list is a convenience mirror.
//
// Persisted to a JSON file under the writable data volume. If that directory
// is unwritable (e.g. local dev without the volume mounted), we fall back to
// in-memory — bans still work for the session, just don't survive a restart.

const filePath = path.join(config.dataDir, 'bans.json')

let bans = []
let persistent = false

function load() {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) bans = parsed
    persistent = true
  } catch (err) {
    if (err.code === 'ENOENT') {
      // No file yet — try to establish that we *can* write here.
      try {
        fs.mkdirSync(config.dataDir, { recursive: true })
        fs.writeFileSync(filePath, '[]', 'utf8')
        persistent = true
      } catch (writeErr) {
        console.warn(
          `[banlist] ${config.dataDir} not writable — banlist is in-memory only:`,
          writeErr.message,
        )
      }
    } else {
      console.warn('[banlist] failed to read banlist, starting empty:', err.message)
    }
  }
}

function persist() {
  if (!persistent) return
  try {
    fs.writeFileSync(filePath, JSON.stringify(bans, null, 2), 'utf8')
  } catch (err) {
    console.warn('[banlist] failed to persist banlist:', err.message)
  }
}

load()

export function listBans() {
  return bans
}

/** Record a ban. De-dupes by userid (latest reason/name/ts wins). */
export function addBan({ userid, name, reason }) {
  const entry = { userid, name: name || null, reason: reason || null, ts: Date.now() }
  bans = bans.filter((b) => b.userid !== userid)
  bans.push(entry)
  persist()
  return entry
}

/** Remove a ban record. Returns true if an entry was removed. */
export function removeBan(userid) {
  const before = bans.length
  bans = bans.filter((b) => b.userid !== userid)
  const removed = bans.length < before
  if (removed) persist()
  return removed
}
