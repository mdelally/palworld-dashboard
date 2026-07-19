import { readFile } from 'node:fs/promises'
import { config } from './config.js'

/**
 * Light parse of PalWorldSettings.ini OptionSettings=(...)
 * Returns a flat key/value map of interesting fields.
 */
export async function readIniSummary() {
  const path = config.palworld.configPath
  if (!path) return null

  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }

  const match = text.match(/OptionSettings=\(([\s\S]*?)\)\s*$/m) || text.match(/OptionSettings=\(([\s\S]*)\)/)
  const body = match?.[1] || text
  const values = {}

  for (const part of body.split(',')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    let value = part.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key) values[key] = value
  }

  const pick = [
    'ServerName',
    'ServerDescription',
    'PublicPort',
    'ServerPlayerMaxNum',
    'CoopPlayerMaxNum',
    'DayTimeSpeedRate',
    'NightTimeSpeedRate',
    'ExpRate',
    'PalCaptureRate',
    'PalSpawnNumRate',
    'DeathPenalty',
    'bEnablePlayerToPlayerDamage',
    'bEnableFastTravel',
    'bAllowGlobalPalboxExport',
    'RESTAPIEnabled',
    'RESTAPIPort',
    'RCONEnabled',
    'RCONPort',
  ]

  const summary = {}
  for (const key of pick) {
    if (values[key] != null) summary[key] = values[key]
  }

  // Never expose secrets
  delete summary.AdminPassword
  delete summary.ServerPassword

  return {
    path,
    fields: summary,
    serverName: summary.ServerName || null,
    maxPlayers: summary.ServerPlayerMaxNum
      ? Number.parseInt(summary.ServerPlayerMaxNum, 10)
      : null,
  }
}
